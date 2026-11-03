import { compareCodePoints, type Params } from "./params.ts";

/**
 * A JSON string literal exactly as Python's json.dumps(ensure_ascii=True)
 * writes it: everything outside printable ASCII becomes a lowercase \uXXXX
 * escape (astral characters as surrogate pairs).
 */
function pyJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i]!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else out += "\\u" + c.toString(16).padStart(4, "0");
  }
  return out + '"';
}

/**
 * The canonical form the Python implementation hashes:
 * json.dumps({k: sorted(v) for k, v in sorted(params.items())}, sort_keys=True)
 *
 * This must stay byte-identical to Python: it keys every stored mapping.
 */
export function canonicalJson(params: Params): string {
  const names = [...params.keys()].sort(compareCodePoints);
  const parts = names.map((name) => {
    const values = [...params.get(name)!].sort(compareCodePoints);
    return `${pyJsonString(name)}: [${values.map(pyJsonString).join(", ")}]`;
  });
  return `{${parts.join(", ")}}`;
}

export async function sha256(data: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return new Uint8Array(digest);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lowercase SHA-256 hex of the canonical params; the storage key format. */
export async function computeHash(params: Params): Promise<string> {
  return toHex(await sha256(canonicalJson(params)));
}
