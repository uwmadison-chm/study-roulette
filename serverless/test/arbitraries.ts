import fc from "fast-check";

const hex = "0123456789abcdefABCDEF";

/** One character of a raw query: weighted toward the ones parsers disagree on. */
const queryChar = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(..."abcxyzAZ09") },
  { weight: 3, arbitrary: fc.constantFrom("%", "+", "=", "&", ";", " ", "~", "*", "/", "?", ":", "@", "'", '"', "\\") },
  // a percent-escape of any byte, including invalid UTF-8 and controls
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 255 }).map((b) => "%" + b.toString(16).padStart(2, "0")) },
  // malformed escapes
  { weight: 1, arbitrary: fc.tuple(fc.constantFrom(...hex), fc.constantFrom("g", "Z", "%", "")).map(([a, b]) => "%" + a + b) },
  // raw non-ASCII, BMP edge and astral
  { weight: 1, arbitrary: fc.constantFrom("é", "中", "￿", "�", "😀", "𝔸") },
  // printable ASCII at large (no '#', which ends a query)
  { weight: 2, arbitrary: fc.integer({ min: 0x20, max: 0x7e }).filter((c) => c !== 0x23).map((c) => String.fromCharCode(c)) },
);

/** A raw query string, without the leading "?". */
export const rawQuery = fc.array(queryChar, { maxLength: 40 }).map((cs) => cs.join(""));

/** A query string shaped like name=value pairs, more likely to produce many params. */
export const pairQuery = fc
  .array(
    fc.tuple(
      fc.array(queryChar, { minLength: 0, maxLength: 6 }).map((cs) => cs.join("")),
      fc.array(queryChar, { maxLength: 10 }).map((cs) => cs.join("")),
    ),
    { maxLength: 6 },
  )
  .map((pairs) => pairs.map(([k, v]) => `${k}=${v}`).join("&"));

export const anyQuery = fc.oneof(rawQuery, pairQuery);

/** A base (study or stored) URL with its own arbitrary query and optional fragment. */
export const baseUrl = fc
  .tuple(
    fc.constantFrom(
      "https://example.com/survey",
      "https://redcap.example.edu/surveys/",
      "HTTPS://Ex.com/p;x",
      "https://e.com",
    ),
    fc.option(anyQuery),
    fc.option(fc.constantFrom("frag", "", "a=b")),
  )
  .map(([head, q, frag]) => head + (q === null ? "" : "?" + q) + (frag === null ? "" : "#" + frag));

/** Params as a Map with arbitrary (well-formed) unicode names and values. */
export const paramsArb = fc
  .uniqueArray(
    fc.tuple(fc.string({ unit: "grapheme", maxLength: 6 }), fc.array(fc.string({ unit: "grapheme", maxLength: 8 }), { minLength: 1, maxLength: 3 })),
    { selector: ([k]) => k, maxLength: 6 },
  )
  .map((entries) => new Map(entries));
