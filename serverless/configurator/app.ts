/**
 * Static configurator for studies.json. Runs entirely in the browser and
 * reuses the app's own validation and routing code, so what it accepts will
 * build and what it previews is what the deployed function does.
 */
import { newSeed, validateConfig, type Config } from "../src/core/config.ts";
import { parseQuery, type Params } from "../src/core/params.ts";
import { computeHash } from "../src/core/hash.ts";
import {
  candidateHashes,
  chooseStudy,
  eligibleStudies,
  keySubset,
  seededUniform,
} from "../src/core/roulette.ts";

interface DraftStudy {
  name: string;
  url: string;
  weight: string;
  note: string;
  required: string;
  key: string;
}

interface Draft {
  seed: string;
  studies: DraftStudy[];
  fallbackUrl: string;
  fallbackNote: string;
}

let draft: Draft | null = null;
let loaded: Config | null = null;
let loadedName = "";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function h(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) el.append(c);
  return el;
}

const splitList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

function draftFromConfig(c: Config): Draft {
  return {
    seed: c.seed,
    studies: c.studies.map((s) => ({
      name: s.name,
      url: s.url,
      weight: String(s.weight),
      note: s.note ?? "",
      required: s.required_params.join(", "),
      key: s.key_params?.join(", ") ?? "",
    })),
    fallbackUrl: c.fallback.url,
    fallbackNote: c.fallback.note ?? "",
  };
}

/** Draft -> plain JSON object, in the shape studies.json uses. */
function draftToJson(d: Draft): unknown {
  return {
    seed: d.seed,
    studies: d.studies.map((s) => {
      const out: Record<string, unknown> = {
        name: s.name.trim(),
        url: s.url.trim(),
        weight: s.weight.trim() === "" ? NaN : Number(s.weight),
      };
      if (s.note.trim()) out["note"] = s.note.trim();
      out["required_params"] = splitList(s.required);
      if (s.key.trim()) out["key_params"] = splitList(s.key);
      return out;
    }),
    fallback: d.fallbackNote.trim()
      ? { url: d.fallbackUrl.trim(), note: d.fallbackNote.trim() }
      : { url: d.fallbackUrl.trim() },
  };
}

function serialize(json: unknown): string {
  return JSON.stringify(json, null, 2) + "\n";
}

// ---- Loading ----

function load(text: string, name: string) {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    alert(`${name} is not valid JSON: ${(e as Error).message}`);
    return;
  }
  const { config, errors } = validateConfig(data);
  if (!config) {
    // Still let people fix it here, as far as the shape allows
    const d = data as Partial<Record<string, unknown>>;
    const studies = Array.isArray(d["studies"]) ? (d["studies"] as Record<string, unknown>[]) : [];
    const fb = (d["fallback"] ?? {}) as Record<string, unknown>;
    draft = {
      seed: typeof d["seed"] === "string" && d["seed"] ? (d["seed"] as string) : newSeed(),
      studies: studies.map((s) => ({
        name: String(s["name"] ?? ""),
        url: String(s["url"] ?? ""),
        weight: String(s["weight"] ?? ""),
        note: String(s["note"] ?? ""),
        required: Array.isArray(s["required_params"]) ? s["required_params"].join(", ") : "",
        key: Array.isArray(s["key_params"]) ? s["key_params"].join(", ") : "",
      })),
      fallbackUrl: String(fb["url"] ?? ""),
      fallbackNote: String(fb["note"] ?? ""),
    };
    loaded = null;
    loadedName = `${name} (had ${errors.length} error${errors.length === 1 ? "" : "s"} when loaded)`;
  } else {
    draft = draftFromConfig(config);
    loaded = config;
    loadedName = name;
  }
  renderAll();
}

$("file").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) load(await f.text(), f.name);
});

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("drop");
});
document.addEventListener("dragleave", () => document.body.classList.remove("drop"));
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  document.body.classList.remove("drop");
  const f = e.dataTransfer?.files[0];
  if (f) load(await f.text(), f.name);
});

$("new").addEventListener("click", () => {
  if (draft && !confirm("Discard the current config and start over?")) return;
  draft = {
    seed: newSeed(),
    studies: [{ name: "", url: "", weight: "1", note: "", required: "", key: "" }],
    fallbackUrl: "",
    fallbackNote: "",
  };
  loaded = null;
  loadedName = "new config";
  renderAll();
});

// ---- Editing ----

function field(label: string, value: string, type: string, onInput: (v: string) => void, full = false) {
  const input = h("input", { type }) as HTMLInputElement;
  input.value = value;
  if (type === "number") {
    input.min = "0";
    input.step = "any";
  }
  input.addEventListener("input", () => {
    onInput(input.value);
    renderChecks();
  });
  return h("div", full ? { class: "full" } : {}, h("label", {}, label), input);
}

function renderStudies() {
  const container = $("studies");
  container.replaceChildren();
  draft!.studies.forEach((s, i) => {
    const up = h("button", { title: "Move up" }, "↑");
    const down = h("button", { title: "Move down" }, "↓");
    const remove = h("button", { title: "Remove" }, "Remove");
    up.addEventListener("click", () => move(i, -1));
    down.addEventListener("click", () => move(i, 1));
    remove.addEventListener("click", () => {
      draft!.studies.splice(i, 1);
      renderAll();
    });
    if (i === 0) up.setAttribute("disabled", "");
    if (i === draft!.studies.length - 1) down.setAttribute("disabled", "");
    container.append(
      h(
        "div",
        { class: "study" },
        field(`Study ${i + 1} URL`, s.url, "url", (v) => (s.url = v), true),
        field("Name (a-z, 0-9, _ or -; used in the randomization log)", s.name, "text", (v) => (s.name = v)),
        field("Weight", s.weight, "number", (v) => (s.weight = v)),
        field("Note", s.note, "text", (v) => (s.note = v)),
        field("Required params (comma-separated)", s.required, "text", (v) => (s.required = v)),
        field("Key params (comma-separated; empty = all params)", s.key, "text", (v) => (s.key = v)),
        h("div", { class: "actions" }, up, down, remove),
      ),
    );
  });
}

function move(i: number, delta: number) {
  const j = i + delta;
  const list = draft!.studies;
  [list[i], list[j]] = [list[j]!, list[i]!];
  renderAll();
}

$("add").addEventListener("click", () => {
  draft!.studies.push({ name: "", url: "", weight: "1", note: "", required: "", key: "" });
  renderAll();
});

$("fb-url").addEventListener("input", (e) => {
  draft!.fallbackUrl = (e.target as HTMLInputElement).value;
  renderChecks();
});
$("fb-note").addEventListener("input", (e) => {
  draft!.fallbackNote = (e.target as HTMLInputElement).value;
  renderChecks();
});

$("reseed").addEventListener("click", () => {
  if (!confirm("A new seed changes which study unvisited links land on. Existing assignments are not affected. Continue?")) return;
  draft!.seed = newSeed();
  $("seed").textContent = draft!.seed;
  renderChecks();
});

// ---- Checks: validation, changes since load ----

function keySignature(keys: string[] | undefined): string {
  return keys === undefined ? "" : JSON.stringify([...keys].sort());
}

function describeKey(keys: string[] | undefined): string {
  return keys === undefined ? "all params" : keys.length ? keys.join(", ") : "(no params)";
}

function changes(before: Config, after: Config): { warnings: string[]; notes: string[] } {
  const warnings: string[] = [];
  const notes: string[] = [];

  // A stored mapping is only found if some study still offers its key set
  // (or it was keyed on all params). Losing a key set orphans those mappings
  // and those visitors get re-randomized.
  const afterKeys = new Set(after.studies.map((s) => keySignature(s.key_params)));
  const lost = new Map<string, string[] | undefined>();
  for (const s of before.studies) {
    const sig = keySignature(s.key_params);
    if (sig && !afterKeys.has(sig)) lost.set(sig, s.key_params);
  }
  for (const keys of lost.values()) {
    warnings.push(
      `No study keys on [${describeKey(keys)}] anymore. People already assigned under that key will be re-randomized.`,
    );
  }

  const beforeUrls = new Map(before.studies.map((s) => [s.url, s]));
  const afterUrls = new Map(after.studies.map((s) => [s.url, s]));
  for (const s of after.studies) {
    const old = beforeUrls.get(s.url);
    if (!old) notes.push(`Added ${s.name}`);
    else {
      const name = s.name;
      if (old.name !== s.name)
        notes.push(`Renamed ${old.name} → ${s.name} (the randomization log keeps earlier entries under ${old.name})`);
      if (old.weight !== s.weight) notes.push(`${name}: weight ${old.weight} → ${s.weight}`);
      if (JSON.stringify(old.required_params) !== JSON.stringify(s.required_params))
        notes.push(`${name}: required params [${old.required_params.join(", ")}] → [${s.required_params.join(", ")}]`);
      if (keySignature(old.key_params) !== keySignature(s.key_params))
        notes.push(`${name}: keyed on [${describeKey(old.key_params)}] → [${describeKey(s.key_params)}]`);
    }
  }
  for (const s of before.studies) {
    if (!afterUrls.has(s.url)) notes.push(`Removed ${s.name} (people already assigned to it keep going there)`);
  }
  if (before.fallback.url !== after.fallback.url) notes.push("Fallback URL changed (applies to new fallback assignments only)");
  if (before.seed !== after.seed) notes.push("Seed changed (applies to links never visited before)");
  return { warnings, notes };
}

function currentConfig(): { config: Config | null; errors: string[] } {
  return validateConfig(draftToJson(draft!));
}

function renderChecks() {
  const { config, errors } = currentConfig();
  const v = $("validation");
  v.replaceChildren();
  if (errors.length) {
    v.append(h("div", { class: "box bad" }, h("strong", {}, "Fix before deploying:"), h("ul", { class: "msgs" }, ...errors.map((e) => h("li", {}, e)))));
  } else {
    v.append(h("div", { class: "box ok" }, "Valid. This config will build."));
  }
  ($("download") as HTMLButtonElement).disabled = !config;
  ($("copy") as HTMLButtonElement).disabled = !config;

  const c = $("changes");
  c.replaceChildren();
  if (config && loaded) {
    const { warnings, notes } = changes(loaded, config);
    if (warnings.length) c.append(h("div", { class: "box warn" }, h("ul", { class: "msgs" }, ...warnings.map((w) => h("li", {}, w)))));
    c.append(
      h(
        "div",
        { class: "muted" },
        notes.length ? `Changes since ${loadedName}: ` : `No changes since ${loadedName}.`,
        ...(notes.length ? [h("ul", { class: "msgs" }, ...notes.map((n) => h("li", {}, n)))] : []),
      ),
    );
  }
  void renderPreview();
}

// ---- Preview ----

function sampleParams(text: string): Params {
  const t = text.trim();
  const q = t.indexOf("?");
  return parseQuery(q === -1 ? (t.includes("=") ? t : "") : t.slice(q + 1).split("#")[0]!);
}

let previewToken = 0;

async function renderPreview() {
  const token = ++previewToken;
  const out = $("preview");
  const { config } = currentConfig();
  const params = sampleParams(($("sample") as HTMLInputElement).value);
  if (!config || params.size === 0) {
    out.replaceChildren(h("p", { class: "muted" }, config ? "Enter a link to see where it would go." : "Fix the errors above to preview."));
    return;
  }

  const eligible = eligibleStudies(config.studies, params);
  const total = eligible.reduce((sum, s) => sum + (s.weight > 0 ? s.weight : 0), 0);
  const chosen = chooseStudy(eligible, await seededUniform(config.seed, params));
  const storageKey = chosen ? keySubset(params, chosen.key_params)! : params;
  const storedHash = await computeHash(storageKey);
  const candidates = await candidateHashes(config.studies, params);
  if (token !== previewToken) return;

  const rows = config.studies.map((s) => {
    const ok = eligible.includes(s);
    const pct = ok && total > 0 && s.weight > 0 ? `${((100 * s.weight) / total).toFixed(1)}%` : "–";
    return h(
      "tr",
      {},
      h("td", {}, s.name),
      h("td", {}, ok ? "yes" : `no (missing ${s.required_params.filter((p) => !params.has(p)).join(", ")})`),
      h("td", { class: "num" }, pct),
      h("td", {}, describeKey(s.key_params)),
    );
  });

  out.replaceChildren(
    h("div", { class: "box ok" },
      "If this exact link has never been visited, it goes to ",
      h("strong", {}, chosen ? chosen.name : `the fallback (${config.fallback.note ?? config.fallback.url})`),
      ", stored under ",
      h("code", {}, storedHash.slice(0, 12)),
      ` (keyed on ${chosen ? describeKey(chosen.key_params) : "all params"}).`,
    ),
    h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Study"), h("th", {}, "Eligible"), h("th", { class: "num" }, "Chance"), h("th", {}, "Keyed on"))),
      h("tbody", {}, ...rows),
    ),
    h("p", { class: "muted" },
      "Existing assignments are looked up first, under these keys in order: ",
      ...candidates.flatMap((c, i) => [i ? ", " : "", h("code", {}, c.slice(0, 12))]),
      ".",
    ),
  );
}

$("sample").addEventListener("input", () => void renderPreview());

// ---- Output ----

$("download").addEventListener("click", () => {
  const blob = new Blob([serialize(draftToJson(draft!))], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: "studies.json" }) as HTMLAnchorElement;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(serialize(draftToJson(draft!)));
  $("copied").textContent = "Copied.";
  setTimeout(() => ($("copied").textContent = ""), 2000);
});

function renderAll() {
  $("editor").hidden = !draft;
  $("source").textContent = draft ? `Editing ${loadedName}.` : "No file loaded. Drop a file anywhere on the page.";
  if (!draft) return;
  renderStudies();
  ($("fb-url") as HTMLInputElement).value = draft.fallbackUrl;
  ($("fb-note") as HTMLInputElement).value = draft.fallbackNote;
  $("seed").textContent = draft.seed;
  renderChecks();
}

renderAll();
