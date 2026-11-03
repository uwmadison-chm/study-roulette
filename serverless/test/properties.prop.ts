// Property tests for the TypeScript core. Run with `npm run test:props`
// (not part of `npm test` or CI).
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { Config, Study } from "../src/core/config.ts";
import { computeHash } from "../src/core/hash.ts";
import { parseQuery, type Params } from "../src/core/params.ts";
import { chooseStudy, eligibleStudies, resolve, seededUniform } from "../src/core/roulette.ts";
import { mergeUrl, urlencode } from "../src/core/urls.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/types.ts";
import { anyQuery, baseUrl, paramsArb } from "./arbitraries.ts";

const NUM_RUNS = Number(process.env["PROP_RUNS"] ?? 1000);
const opts = { numRuns: NUM_RUNS };

function shuffled<T>(xs: T[], order: number[]): T[] {
  return xs
    .map((x, i) => [x, order[i % order.length]! + i / 1000] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([x]) => x);
}

test("hash ignores param order and value order", async () => {
  await fc.assert(
    fc.asyncProperty(paramsArb, fc.array(fc.integer(), { minLength: 1, maxLength: 10 }), async (params, order) => {
      const permuted: Params = new Map(
        shuffled([...params], order).map(([k, vs]) => [k, shuffled(vs, [...order].reverse())]),
      );
      assert.equal(await computeHash(permuted), await computeHash(params));
    }),
    opts,
  );
});

test("urlencode then parseQuery round-trips", () => {
  fc.assert(
    fc.property(paramsArb, (params) => {
      assert.deepEqual([...parseQuery(urlencode(params))], [...params]);
    }),
    opts,
  );
});

test("parsing a query is idempotent through urlencode", () => {
  fc.assert(
    fc.property(anyQuery, (q) => {
      const once = parseQuery(q);
      assert.deepEqual([...parseQuery(urlencode(once))], [...once]);
    }),
    opts,
  );
});

/** The query part of a URL, as urlparse splits it: after the first "?", before the first "#". */
function queryOf(url: string): string {
  const noFrag = url.split("#")[0]!;
  const q = noFrag.indexOf("?");
  return q === -1 ? "" : noFrag.slice(q + 1);
}

/** Everything before the query and fragment. */
function headOf(url: string): string {
  return url.split("#")[0]!.split("?")[0]!;
}

test("merge: base params win, incoming-only params are forwarded, path is kept", () => {
  fc.assert(
    fc.property(baseUrl, anyQuery, (base, q) => {
      const incoming = parseQuery(q);
      const merged = mergeUrl(base, incoming);
      const baseQuery = parseQuery(queryOf(base));
      const mergedQuery = parseQuery(queryOf(merged));
      for (const [k, vs] of baseQuery) assert.deepEqual(mergedQuery.get(k), vs, `base param ${k}`);
      for (const [k, vs] of incoming) if (!baseQuery.has(k)) assert.deepEqual(mergedQuery.get(k), vs, `incoming ${k}`);
      assert.equal(mergedQuery.size, new Set([...baseQuery.keys(), ...incoming.keys()]).size);
      assert.equal(headOf(merged).toLowerCase(), headOf(base).toLowerCase());
    }),
    opts,
  );
});

test("merging is idempotent: re-merging the same params changes nothing", () => {
  fc.assert(
    fc.property(baseUrl, anyQuery, (base, q) => {
      const p = parseQuery(q);
      const once = mergeUrl(base, p);
      assert.equal(mergeUrl(once, p), once);
    }),
    opts,
  );
});

// ---- Routing ----

const PARAM_POOL = ["email", "ts", "cn", "id"];
const paramNames = fc.subarray(PARAM_POOL);

const studyArb: fc.Arbitrary<Study> = fc
  .record({
    n: fc.integer({ min: 0, max: 99 }),
    weight: fc.oneof(fc.constant(0), fc.double({ min: 0.01, max: 10, noNaN: true })),
    required: paramNames,
    keyMode: fc.constantFrom("all", "subset"),
    keyPick: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
  })
  .map(({ n, weight, required, keyMode, keyPick }) => {
    const s: Study = { name: `s${n}`, url: `https://example.com/s${n}`, weight, required_params: required };
    if (keyMode === "subset") s.key_params = required.filter((_, i) => keyPick[i]);
    return s;
  });

const configArb: fc.Arbitrary<Config> = fc.record({
  seed: fc.string({ minLength: 1, maxLength: 8 }),
  studies: fc.array(studyArb, { maxLength: 5 }),
  fallback: fc.constant({ name: "fallback", url: "https://example.com/fallback" }),
});

const visitParams = fc
  .tuple(fc.subarray(PARAM_POOL, { minLength: 1 }), fc.array(fc.string({ maxLength: 4 }), { minLength: 4, maxLength: 4 }))
  .map(([names, values]) => new Map(names.map((n, i) => [n, [values[i]!]])) as Params);

test("seeded choice is in range and picks an eligible, positively weighted study", async () => {
  await fc.assert(
    fc.asyncProperty(configArb, visitParams, async (config, params) => {
      const u = await seededUniform(config.seed, params);
      assert.ok(u >= 0 && u < 1);
      const eligible = eligibleStudies(config.studies, params);
      const chosen = chooseStudy(eligible, u);
      if (chosen === null) assert.ok(eligible.every((s) => s.weight === 0));
      else {
        assert.ok(eligible.includes(chosen));
        assert.ok(chosen.weight > 0);
      }
    }),
    opts,
  );
});

test("a stored assignment never changes on later visits", async () => {
  await fc.assert(
    fc.asyncProperty(configArb, visitParams, fc.array(visitParams, { maxLength: 4 }), async (config, first, others) => {
      const store = new MemoryStore();
      const url = await resolve(store, config, first);
      for (const p of others) await resolve(store, config, p);
      assert.equal(await resolve(store, config, first), url);
    }),
    opts,
  );
});

test("concurrent identical visits, under any interleaving, store one mapping and agree", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      configArb,
      visitParams,
      fc.integer({ min: 2, max: 6 }),
      async (s, config, params, n) => {
        const inner = new MemoryStore();
        // Every storage call yields to the scheduler, which picks the order
        const store: Store = {
          get: (k) => s.schedule(Promise.resolve(), `get ${k.slice(0, 6)}`).then(() => inner.get(k)),
          putIfAbsent: (k, v) =>
            s.schedule(Promise.resolve(), `put ${k.slice(0, 6)}`).then(() => inner.putIfAbsent(k, v)),
        };
        const visits = Array.from({ length: n }, () => resolve(store, config, params));
        // Release scheduled storage calls, in the scheduler's order, until all visits finish
        const urls = await s.waitFor(Promise.all(visits));
        assert.equal(new Set(urls).size, 1, "all visits agree");
        assert.equal(inner.data.size, 1, "one stored mapping");
      },
    ),
    opts,
  );
});
