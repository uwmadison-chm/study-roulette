// Proves the TypeScript port parses, hashes and merges exactly like the
// Python implementation. Regenerate golden.json with `npm run golden`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { computeHash } from "../src/core/hash.ts";
import { parseQuery } from "../src/core/params.ts";
import { mergeUrl } from "../src/core/urls.ts";

interface Case {
  query: string;
  params: [string, string[]][];
  hash: string;
  merges: { base: string; result: string }[];
}

const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8")) as {
  cases: Case[];
};

for (const c of golden.cases) {
  test(`matches Python for ?${c.query}`, async () => {
    const params = parseQuery(c.query);
    assert.deepEqual([...params], c.params, "parsed params");
    assert.equal(await computeHash(params), c.hash, "hash");
    for (const m of c.merges) assert.equal(mergeUrl(m.base, params), m.result, `merge into ${m.base}`);
  });
}

test("hash format is frozen (same value the Python test pins)", async () => {
  const params = new Map([
    ["email", ["foo@bar.com"]],
    ["ts", ["12345"]],
  ]);
  assert.equal(
    await computeHash(params),
    "57499226b526e9e6429b0a53afbbb566746d9510ca9299022233b2af17d17ea9",
  );
});
