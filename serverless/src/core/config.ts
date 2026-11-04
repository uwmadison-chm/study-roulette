/**
 * Routing configuration. Shared by the build (which refuses to ship an
 * invalid config) and the configurator page (which validates as you edit).
 */

export interface Study {
  /** Short identifier used in logs; [a-z0-9_-], unique. */
  name: string;
  url: string;
  weight: number;
  note?: string;
  /** Params that must all be present (blank counts) for eligibility. */
  required_params: string[];
  /** Subset of required_params that keys the stored mapping; absent = all params. */
  key_params?: string[];
}

export interface Fallback {
  /** Like a study's name; must differ from every study's. */
  name: string;
  url: string;
  note?: string;
}

export interface Config {
  /**
   * Non-secret value mixed into the hash that seeds study choice. Changing it
   * only affects visitors who have no stored mapping yet.
   */
  seed: string;
  studies: Study[];
  fallback: Fallback;
}

/** Allowed study names: safe in object keys and file names on every OS. */
export const NAME_PATTERN = /^[a-z0-9_-]{1,64}$/;

export interface ValidationResult {
  config: Config | null;
  errors: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkUrl(v: unknown, label: string, errors: string[]): string | null {
  if (typeof v !== "string") {
    errors.push(`${label}: 'url' must be a string`);
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    errors.push(`${label}: invalid URL '${v}'`);
    return null;
  }
  if (!parsed.protocol || !parsed.host) {
    errors.push(`${label}: invalid URL '${v}'`);
    return null;
  }
  return v;
}

function checkParamList(
  entry: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
): string[] | undefined | null {
  if (!(key in entry) || entry[key] === undefined) return undefined;
  const v = entry[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    errors.push(`${label}: '${key}' must be an array of strings`);
    return null;
  }
  return v as string[];
}

function checkNote(entry: Record<string, unknown>, label: string, errors: string[]): string | undefined {
  const note = entry["note"];
  if (note === undefined) return undefined;
  if (typeof note !== "string") {
    errors.push(`${label}: 'note' must be a string`);
    return undefined;
  }
  return note;
}

const STUDY_KEYS = new Set(["name", "url", "weight", "note", "required_params", "key_params"]);
const FALLBACK_KEYS = new Set(["name", "url", "note"]);

function checkStudy(entry: unknown, index: number, errors: string[]): Study | null {
  const label = `studies[${index}]`;
  if (!isRecord(entry)) {
    errors.push(`${label}: expected an object`);
    return null;
  }
  const before = errors.length;
  for (const k of Object.keys(entry)) {
    if (!STUDY_KEYS.has(k)) errors.push(`${label}: unknown key '${k}'`);
  }
  const name = entry["name"];
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    errors.push(`${label}: 'name' must be 1-64 characters of a-z, 0-9, _ or -`);
  }
  const url = checkUrl(entry["url"], label, errors);
  const weight = entry["weight"];
  if (typeof weight !== "number" || !Number.isFinite(weight)) {
    errors.push(`${label}: 'weight' must be a number`);
  } else if (weight < 0) {
    errors.push(`${label}: weight must be non-negative, got ${weight}`);
  }
  const note = checkNote(entry, label, errors);
  const required = checkParamList(entry, "required_params", label, errors);
  const key = checkParamList(entry, "key_params", label, errors);
  if (Array.isArray(key)) {
    const req = Array.isArray(required) ? required : [];
    const missing = key.filter((p) => !req.includes(p));
    if (missing.length) {
      errors.push(
        `${label}: key_params must be a subset of required_params, but ${JSON.stringify(missing)} are not in required_params`,
      );
    }
  }
  if (errors.length > before || url === null) return null;
  const study: Study = {
    name: name as string,
    url,
    weight: weight as number,
    required_params: required ?? [],
  };
  if (note !== undefined) study.note = note;
  if (key) study.key_params = key;
  return study;
}

/** Validate an untrusted value (parsed JSON) as a Config. */
export function validateConfig(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(data)) return { config: null, errors: ["config must be a JSON object"] };

  for (const k of Object.keys(data)) {
    if (!["seed", "studies", "fallback"].includes(k)) errors.push(`unknown top-level key '${k}'`);
  }

  const seed = data["seed"];
  if (typeof seed !== "string" || seed.length === 0) {
    errors.push("'seed' must be a non-empty string");
  }

  const studies: Study[] = [];
  let studiesSeen = new Set<string>();
  if (!Array.isArray(data["studies"])) {
    errors.push("'studies' must be an array");
  } else {
    const seen = new Set<string>();
    studiesSeen = seen;
    data["studies"].forEach((entry, i) => {
      const s = checkStudy(entry, i, errors);
      if (!s) return;
      if (seen.has(s.name)) errors.push(`studies[${i}]: duplicate name '${s.name}'`);
      seen.add(s.name);
      studies.push(s);
    });
  }

  let fallback: Fallback | null = null;
  const fb = data["fallback"];
  if (!isRecord(fb)) {
    errors.push("missing required 'fallback' object");
  } else {
    for (const k of Object.keys(fb)) {
      if (!FALLBACK_KEYS.has(k)) errors.push(`fallback: must not have '${k}'`);
    }
    const name = fb["name"];
    const nameOk = typeof name === "string" && NAME_PATTERN.test(name);
    if (!nameOk) errors.push("fallback: 'name' must be 1-64 characters of a-z, 0-9, _ or -");
    else if (studiesSeen.has(name)) errors.push(`fallback: name '${name}' is already used by a study`);
    const url = checkUrl(fb["url"], "fallback", errors);
    const note = checkNote(fb, "fallback", errors);
    if (url && nameOk) fallback = note === undefined ? { name, url } : { name, url, note };
  }

  if (errors.length || !fallback) return { config: null, errors };
  return { config: { seed: seed as string, studies, fallback }, errors };
}

/** Make a fresh random seed (for the configurator and the TOML converter). */
export function newSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
