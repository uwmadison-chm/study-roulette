import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateConfig } from "../src/core/config.ts";

const ok = {
  seed: "abc",
  studies: [
    { name: "a", url: "https://example.com/a", weight: 1, required_params: ["email"], key_params: ["email"] },
    { name: "b", url: "https://example.com/b", weight: 0, note: "paused", required_params: [] },
  ],
  fallback: { name: "registry", url: "https://example.com/f" },
};

test("accepts a valid config", () => {
  const { config, errors } = validateConfig(ok);
  assert.deepEqual(errors, []);
  assert.equal(config?.studies.length, 2);
  assert.equal(config?.studies[1]?.key_params, undefined);
});

test("the example config is valid", () => {
  const data = JSON.parse(readFileSync(new URL("../studies.example.json", import.meta.url), "utf8"));
  assert.deepEqual(validateConfig(data).errors, []);
});

const bad: [string, (c: any) => void, RegExp][] = [
  ["missing name", (c) => delete c.studies[0].name, /'name' must be/],
  ["bad name", (c) => (c.studies[0].name = "Control Group"), /'name' must be/],
  ["duplicate name", (c) => (c.studies[1].name = "a"), /duplicate name 'a'/],
  ["fallback name missing", (c) => delete c.fallback.name, /fallback: 'name' must be/],
  ["fallback name clashes", (c) => (c.fallback.name = "a"), /already used by a study/],
  ["missing seed", (c) => delete c.seed, /seed/],
  ["bad url", (c) => (c.studies[0].url = "not a url"), /invalid URL/],
  ["negative weight", (c) => (c.studies[0].weight = -1), /non-negative/],
  ["string weight", (c) => (c.studies[0].weight = "1"), /must be a number/],
  ["key not subset", (c) => (c.studies[0].key_params = ["ts"]), /subset/],
  ["unknown study key", (c) => (c.studies[0].wieght = 1), /unknown key 'wieght'/],
  ["fallback with weight", (c) => (c.fallback.weight = 1), /fallback: must not have 'weight'/],
  ["no fallback", (c) => delete c.fallback, /fallback/],
  ["params not strings", (c) => (c.studies[0].required_params = [1]), /array of strings/],
];

for (const [name, mutate, pattern] of bad) {
  test(`rejects: ${name}`, () => {
    const c = structuredClone(ok) as any;
    mutate(c);
    const { config, errors } = validateConfig(c);
    assert.equal(config, null);
    assert.ok(errors.some((e) => pattern.test(e)), errors.join("; "));
  });
}
