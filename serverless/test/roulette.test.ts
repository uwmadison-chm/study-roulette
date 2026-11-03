import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { computeHash } from "../src/core/hash.ts";
import { candidateHashes, chooseStudy, oldestHit, resolve, seededUniform } from "../src/core/roulette.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { config, FALLBACK, gate, params } from "./helpers.ts";

describe("candidateHashes", () => {
  test("most specific first, then study order", async () => {
    const studies = config([
      { url: "https://example.com/a", required_params: ["email"], key_params: ["email"] },
      { url: "https://example.com/b", required_params: ["email", "ts"], key_params: ["email", "ts"] },
    ]).studies;
    const p = params({ email: "foo@bar.com", ts: "1", cn: "9" });
    assert.deepEqual(await candidateHashes(studies, p), [
      await computeHash(p),
      await computeHash(params({ email: "foo@bar.com", ts: "1" })),
      await computeHash(params({ email: "foo@bar.com" })),
    ]);
  });

  test("skips studies missing key params and dedupes", async () => {
    const studies = config([
      { required_params: ["email"], key_params: ["email"] },
      { required_params: ["x"], key_params: ["x"] },
    ]).studies;
    const p = params({ email: "a" });
    assert.deepEqual(await candidateHashes(studies, p), [await computeHash(p)]);
  });
});

describe("seeded choice", () => {
  test("is deterministic per seed and params", async () => {
    const p = params({ email: "a@b.c" });
    assert.equal(await seededUniform("s", p), await seededUniform("s", p));
    assert.notEqual(await seededUniform("s", p), await seededUniform("t", p));
  });

  test("respects weights over many links", async () => {
    const studies = config([
      { url: "https://example.com/a", weight: 1 },
      { url: "https://example.com/b", weight: 3 },
      { url: "https://example.com/zero", weight: 0 },
    ]).studies;
    const counts: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const s = chooseStudy(studies, await seededUniform("seed", params({ id: String(i) })))!;
      counts[s.url] = (counts[s.url] ?? 0) + 1;
    }
    assert.equal(counts["https://example.com/zero"], undefined);
    const shareB = counts["https://example.com/b"]! / 4000;
    assert.ok(shareB > 0.72 && shareB < 0.78, `b share ${shareB}`);
  });

  test("returns null when nothing has positive weight", () => {
    assert.equal(chooseStudy(config([{ weight: 0 }]).studies, 0.5), null);
  });
});

describe("resolve", () => {
  test("creates a mapping and returns the merged URL", async () => {
    const store = new MemoryStore();
    const c = config([{ url: "https://example.com/survey?s=abc" }]);
    const url = await resolve(store, c, params({ email: "foo@bar.com" }));
    assert.equal(url, "https://example.com/survey?email=foo%40bar.com&s=abc");
    assert.equal(store.data.size, 1);
  });

  test("returns the stored mapping on later visits", async () => {
    const store = new MemoryStore();
    const c = config([{ url: "https://example.com/a" }, { url: "https://example.com/b" }]);
    const p = params({ id: "1" });
    assert.equal(await resolve(store, c, p), await resolve(store, c, p));
    assert.equal(store.puts, 1);
  });

  test("uses the fallback when no study is eligible or weighted", async () => {
    const store = new MemoryStore();
    const c = config([
      { url: "https://example.com/a", required_params: ["email"] },
      { url: "https://example.com/z", weight: 0 },
    ]);
    const url = await resolve(store, c, params({ id: "123" }));
    assert.ok(url.startsWith(FALLBACK.url));
    assert.ok(url.includes("id=123"));
  });

  test("only eligible studies are chosen", async () => {
    const c = config([
      { url: "https://example.com/a", required_params: ["email"] },
      { url: "https://example.com/b", required_params: ["email", "ts"] },
    ]);
    for (let i = 0; i < 50; i++) {
      const url = await resolve(new MemoryStore(), c, params({ email: `${i}@x` }));
      assert.ok(url.startsWith("https://example.com/a"));
    }
  });

  test("key params keep assignment stable as other params change; stored values win", async () => {
    const store = new MemoryStore();
    const c = config([
      { url: "https://example.com/a", required_params: ["email"], key_params: ["email"] },
      { url: "https://example.com/b", required_params: ["email"], key_params: ["email"] },
    ]);
    const first = await resolve(store, c, params({ email: "e@x", ts: "111", cn: "9" }));
    for (let i = 0; i < 20; i++) {
      const later = await resolve(store, c, params({ email: "e@x", ts: String(i) }));
      // ts conflicts and cn is missing: both come from the stored URL
      assert.equal(later, first);
    }
    const withNew = await resolve(store, c, params({ email: "e@x", utm: "news" }));
    // Incoming keys keep their order; stored values replace in place; stored-only keys follow
    assert.equal(withNew, first.replace("?email=e%40x&", "?email=e%40x&utm=news&"));
  });

  test("honors legacy all-params mappings", async () => {
    const store = new MemoryStore();
    const p = params({ email: "foo@bar.com", ts: "12345" });
    store.data.set(await computeHash(p), "https://example.com/legacy?email=foo%40bar.com&ts=12345\n");
    const c = config([{ url: "https://example.com/new", required_params: ["email"], key_params: ["email"] }]);
    assert.equal(await resolve(store, c, p), "https://example.com/legacy?email=foo%40bar.com&ts=12345");
  });
});

describe("oldest mapping wins", () => {
  test("oldestHit picks the earliest creation time; ties and unknowns go to precedence", () => {
    assert.equal(oldestHit([null, null]), -1);
    assert.equal(oldestHit([{ value: "a", created: 2 }, { value: "b", created: 1 }]), 1);
    assert.equal(oldestHit([{ value: "a", created: 1 }, { value: "b", created: 1 }]), 0);
    assert.equal(oldestHit([{ value: "a" }, { value: "b", created: 5 }]), 1);
    assert.equal(oldestHit([{ value: "a" }, { value: "b" }]), 0);
    assert.equal(oldestHit([null, { value: "b", created: 9 }]), 1);
  });

  test("a later visit under a higher-precedence key does not move an earlier assignment", async () => {
    // Study a keys on email but cannot be chosen (weight 0); study b keys on id
    const c = config([
      { url: "https://example.com/a", weight: 0, required_params: ["email"], key_params: ["email"] },
      { url: "https://example.com/b", required_params: ["id"], key_params: ["id"] },
    ]);
    const store = new MemoryStore();
    const first = await resolve(store, c, params({ email: "e@x", id: "7" }));
    assert.ok(first.startsWith("https://example.com/b"));
    // Only email: falls back, stored under the email key, which outranks id
    const other = await resolve(store, c, params({ email: "e@x" }));
    assert.ok(other.startsWith(FALLBACK.url));
    assert.equal(await resolve(store, c, params({ email: "e@x", id: "7" })), first);
  });
});

describe("races", () => {
  test("N concurrent identical visits store one mapping and all get the same URL", async () => {
    // Studies with different key_params: under random choice, concurrent
    // visits could pick different studies and write different keys.
    const c = config([
      { url: "https://example.com/a", required_params: ["email"], key_params: ["email"] },
      { url: "https://example.com/b", required_params: ["email", "ts"], key_params: ["email", "ts"] },
      { url: "https://example.com/c" },
    ]);
    for (let link = 0; link < 30; link++) {
      const g = gate();
      let arrived = 0;
      const N = 8;
      // Hold every visit after its reads until all have read: worst case
      const store = new MemoryStore({
        afterGet: async () => {
          if (++arrived === N * 3) g.open();
          await g.wait;
        },
      });
      const p = params({ email: `p${link}@x`, ts: "1", cn: "2" });
      const urls = await Promise.all(Array.from({ length: N }, () => resolve(store, c, p)));
      assert.equal(new Set(urls).size, 1, "all visits get one URL");
      assert.equal(store.data.size, 1, "exactly one stored mapping");
      assert.equal(store.puts, N, "every visit attempted the conditional create");
    }
  });

  test("a visit that loses the race returns the winner's URL merged with its own params", async () => {
    const c = config([{ url: "https://example.com/a", required_params: ["email"], key_params: ["email"] }]);
    const g = gate();
    let reads = 0;
    const store = new MemoryStore({
      afterGet: async () => {
        if (++reads === 2) g.open();
        await g.wait;
      },
    });
    const [x, y] = await Promise.all([
      resolve(store, c, params({ email: "e", ts: "1" })),
      resolve(store, c, params({ email: "e", src: "scan" })),
    ]);
    assert.equal(store.data.size, 1);
    const stored = [...store.data.values()][0]!.trim();
    assert.ok([x, y].includes(stored));
    // The loser gets the winner's destination, plus its own extra param
    const [winner, loser] = x === stored ? [x, y] : [y, x];
    const w = new URL(winner);
    const l = new URL(loser);
    assert.equal(l.pathname, w.pathname);
    for (const [k, v] of w.searchParams) assert.equal(l.searchParams.get(k), v);
    assert.ok(l.searchParams.has("src") || l.searchParams.has("ts"));
  });
});
