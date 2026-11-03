import type { Config, Study } from "./config.ts";
import { canonicalJson, computeHash, sha256 } from "./hash.ts";
import type { Params } from "./params.ts";
import type { Entry, Store } from "../store/types.ts";
import { mergeUrl } from "./urls.ts";

/** Studies whose required_params are all present (blank counts as present). */
export function eligibleStudies(studies: Study[], params: Params): Study[] {
  return studies.filter((s) => s.required_params.every((p) => params.has(p)));
}

/**
 * The subset of params a study keys on. Undefined key_params means all
 * params. Returns null if any key param is missing.
 */
export function keySubset(params: Params, keyParams: string[] | undefined): Params | null {
  if (keyParams === undefined) return new Map(params);
  if (!keyParams.every((k) => params.has(k))) return null;
  return new Map(keyParams.map((k) => [k, params.get(k)!]));
}

/**
 * Storage keys to check for an existing mapping, in precedence order: the
 * all-params key plus each study's key subset where present; most param
 * names first, then study order, with the all-params key winning ties.
 */
export async function candidateHashes(studies: Study[], params: Params): Promise<string[]> {
  const candidates: { size: number; order: number; hash: string }[] = [
    { size: params.size, order: -1, hash: await computeHash(params) },
  ];
  for (const [i, study] of studies.entries()) {
    if (study.key_params === undefined) continue;
    const subset = keySubset(params, study.key_params);
    if (subset === null) continue;
    candidates.push({ size: subset.size, order: i, hash: await computeHash(subset) });
  }
  candidates.sort((a, b) => b.size - a.size || a.order - b.order);
  return [...new Set(candidates.map((c) => c.hash))];
}

/**
 * A number in [0, 1) derived from the config seed and the full param set.
 * Identical links always get the same number, so concurrent duplicate visits
 * (link scanners, double clicks) choose the same study and so race for the
 * same storage key.
 */
export async function seededUniform(seed: string, params: Params): Promise<number> {
  const digest = await sha256(`${seed}\n${canonicalJson(params)}`);
  // Top 53 bits of the digest, scaled to [0, 1)
  const top = new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0);
  return Number(top >> 11n) / 2 ** 53;
}

/** Weighted choice among studies with positive weight, driven by u in [0, 1). */
export function chooseStudy(studies: Study[], u: number): Study | null {
  const positive = studies.filter((s) => s.weight > 0);
  const total = positive.reduce((sum, s) => sum + s.weight, 0);
  if (positive.length === 0 || total <= 0) return null;
  const target = u * total;
  let cumulative = 0;
  for (const s of positive) {
    cumulative += s.weight;
    if (target < cumulative) return s;
  }
  return positive[positive.length - 1]!;
}

export type Outcome = "existing" | "created" | "race_lost" | "fallback_created";

export interface Resolution {
  url: string;
  outcome: Outcome;
  /** Storage key (hash) the destination is stored under. */
  key: string;
  /** Index into config.studies of the newly chosen study; absent for existing mappings and the fallback. */
  study?: number;
}

/**
 * Get the stored destination for these params, or assign and store one.
 *
 * A stored mapping always wins, and its parameters win over the current
 * visit's. When several candidate keys hold mappings (studies keyed on
 * different params, visited with different param sets), the oldest wins, so
 * a later visit can never move an earlier assignment; ties fall back to
 * candidate precedence. New mappings are created with a conditional write, so of any
 * number of concurrent visits racing for one key, exactly one is stored and
 * every visit returns it.
 */
export async function resolveDetailed(store: Store, config: Config, params: Params): Promise<Resolution> {
  // Read every candidate in parallel (one round trip)
  const hashes = await candidateHashes(config.studies, params);
  const found = await Promise.all(hashes.map((hash) => store.get(hash)));
  const hit = oldestHit(found);
  if (hit !== -1) return { url: mergeUrl(found[hit]!.value, params), outcome: "existing", key: hashes[hit]! };

  const chosen = chooseStudy(
    eligibleStudies(config.studies, params),
    await seededUniform(config.seed, params),
  );
  // key_params is a subset of required_params, which eligibility guarantees
  // are present, so the subset always exists
  const storageKey = chosen ? keySubset(params, chosen.key_params)! : params;
  const baseUrl = chosen ? chosen.url : config.fallback.url;

  const key = await computeHash(storageKey);
  const destination = mergeUrl(baseUrl, params);
  if (await store.putIfAbsent(key, destination + "\n")) {
    return chosen
      ? { url: destination, outcome: "created", key, study: config.studies.indexOf(chosen) }
      : { url: destination, outcome: "fallback_created", key };
  }

  // Someone else created this mapping between our read and our write
  const winner = await store.get(key);
  if (winner === null) throw new Error(`mapping ${key} vanished after conditional write conflict`);
  return { url: mergeUrl(winner.value, params), outcome: "race_lost", key };
}

/**
 * Index of the entry to use: the oldest by creation time, ties (or unknown
 * times) going to the earlier candidate. -1 if nothing was found.
 */
export function oldestHit(found: (Entry | null)[]): number {
  let best = -1;
  for (const [i, e] of found.entries()) {
    if (e === null) continue;
    if (best === -1) {
      best = i;
      continue;
    }
    const a = e.created ?? Infinity;
    const b = found[best]!.created ?? Infinity;
    if (a < b) best = i;
  }
  return best;
}

export async function resolve(store: Store, config: Config, params: Params): Promise<string> {
  return (await resolveDetailed(store, config, params)).url;
}
