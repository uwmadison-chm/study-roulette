/**
 * Query parameters as an ordered map of name -> values, mirroring the
 * dict[str, list[str]] the Python implementation builds. Insertion order is
 * the order of first appearance, which matters for URL merging.
 */
export type Params = Map<string, string[]>;

/**
 * Percent-decode the way Python's urllib.parse.unquote does: ASCII runs are
 * decoded to bytes and then as UTF-8 with replacement characters for invalid
 * sequences; non-ASCII characters pass through untouched; malformed %
 * escapes are left as-is.
 */
export function unquote(s: string): string {
  if (!s.includes("%")) return s;
  let out = "";
  // Split into maximal ASCII / non-ASCII runs, as Python does
  for (const run of s.match(/[\x00-\x7f]+|[^\x00-\x7f]+/g) ?? []) {
    if (run.charCodeAt(0) > 0x7f) {
      out += run;
      continue;
    }
    const bytes: number[] = [];
    for (let i = 0; i < run.length; i++) {
      const c = run.charCodeAt(i);
      if (c === 0x25 /* % */ && /^[0-9a-fA-F]{2}$/.test(run.slice(i + 1, i + 3))) {
        bytes.push(parseInt(run.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(c);
      }
    }
    out += new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }
  return out;
}

/**
 * Parse a raw query string (without the leading "?") the way
 * urllib.parse.parse_qsl(keep_blank_values=True) does: split on "&", skip
 * empty pieces, split each on the first "=", treat "+" as space.
 */
export function parseQuery(raw: string): Params {
  const params: Params = new Map();
  if (raw.startsWith("?")) raw = raw.slice(1);
  for (const piece of raw.split("&")) {
    if (!piece) continue;
    const eq = piece.indexOf("=");
    const rawName = eq === -1 ? piece : piece.slice(0, eq);
    const rawValue = eq === -1 ? "" : piece.slice(eq + 1);
    const name = unquote(rawName.replaceAll("+", " "));
    const value = unquote(rawValue.replaceAll("+", " "));
    const values = params.get(name);
    if (values) values.push(value);
    else params.set(name, [value]);
  }
  return params;
}

/** Python's default str ordering: by code point, not UTF-16 unit. */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}
