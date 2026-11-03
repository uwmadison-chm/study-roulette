import assert from "node:assert/strict";
import { test } from "node:test";
import { compactTimestamp, handle } from "../src/core/handler.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/types.ts";
import { config } from "./helpers.ts";

const c = config([{ url: "https://example.com/survey?s=abc" }]);
const deps = (store: Store = new MemoryStore()) => ({ store, config: c, buildId: "test-build" });

test("GET with params redirects with 302 and build header", async () => {
  const res = await handle(new Request("https://sr.example.edu/sr?email=a%40b.c"), deps());
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://example.com/survey?email=a%40b.c&s=abc");
  assert.equal(res.headers.get("x-roulette-build"), "test-build");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("HEAD assigns like GET", async () => {
  const store = new MemoryStore();
  const head = await handle(new Request("https://x/?id=1", { method: "HEAD" }), deps(store));
  const get = await handle(new Request("https://x/?id=1"), deps(store));
  assert.equal(head.status, 302);
  assert.equal(head.headers.get("location"), get.headers.get("location"));
  assert.equal(store.data.size, 1);
});

test("no params is 404", async () => {
  const res = await handle(new Request("https://x/"), deps());
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { errors: ["No parameters specified"] });
});

test("other methods are 405", async () => {
  const res = await handle(new Request("https://x/?a=1", { method: "POST" }), deps());
  assert.equal(res.status, 405);
});

test("storage failure is 500 and leaks nothing", async () => {
  const broken: Store = {
    get: async () => {
      throw new Error("secret-ish detail");
    },
    putIfAbsent: async () => true,
  };
  const logged: string[] = [];
  const res = await handle(new Request("https://x/?a=1"), { ...deps(broken), log: (m) => logged.push(m) });
  assert.equal(res.status, 500);
  assert.ok(!(await res.text()).includes("secret-ish"));
  assert.ok(logged[0]?.includes("secret-ish detail"));
});

test("info logs one JSON line per redirect without raw params", async () => {
  const logged: string[] = [];
  const store = new MemoryStore();
  await handle(new Request("https://x/?email=a%40b.c"), { ...deps(store), log: (m) => logged.push(m) });
  await handle(new Request("https://x/?email=a%40b.c"), { ...deps(store), log: (m) => logged.push(m) });
  const [first, second] = logged.map((l) => JSON.parse(l));
  assert.equal(first.outcome, "created");
  assert.equal(first.study, "s0");
  assert.equal(second.outcome, "existing");
  assert.equal(first.key.length, 12);
  assert.ok(!logged.join("").includes("a@b.c"));
});

test("debug adds params; error level logs only failures", async () => {
  const logged: string[] = [];
  await handle(new Request("https://x/?email=a%40b.c"), { ...deps(), log: (m) => logged.push(m), logLevel: "debug" });
  assert.deepEqual(JSON.parse(logged[0]!).params, { email: ["a@b.c"] });
  logged.length = 0;
  await handle(new Request("https://x/?email=a%40b.c"), { ...deps(), log: (m) => logged.push(m), logLevel: "error" });
  assert.equal(logged.length, 0);
});

test("each new assignment writes one zero-byte randomization log entry", async () => {
  const store = new MemoryStore();
  const log = new MemoryStore();
  const at = new Date("2026-11-03T16:42:31.456Z");
  const d = { ...deps(store), randomizationLog: log, now: () => at };
  await handle(new Request("https://x/?email=a"), d);
  await handle(new Request("https://x/?email=a"), d); // returning visitor: no entry
  await handle(new Request("https://x/?email=b"), d);
  const keys = [...log.data.keys()].sort();
  assert.equal(keys.length, 2);
  for (const k of keys) assert.match(k, /^s0\/20261103T164231Z_[0-9a-f]{8}$/);
  assert.ok([...log.data.values()].every((v) => v === ""));
});

test("fallback assignments are logged under the fallback's name", async () => {
  const log = new MemoryStore();
  const c = config([{ url: "https://example.com/a", required_params: ["email"] }]);
  await handle(new Request("https://x/?id=1"), { store: new MemoryStore(), config: c, buildId: "b", randomizationLog: log });
  assert.match([...log.data.keys()][0]!, /^registry\/\d{8}T\d{6}Z_/);
});

test("a failed log write still redirects and is logged", async () => {
  const logged: string[] = [];
  const broken: Store = {
    get: async () => null,
    putIfAbsent: async () => {
      throw new Error("log bucket down");
    },
  };
  const res = await handle(new Request("https://x/?a=1"), { ...deps(), randomizationLog: broken, log: (m) => logged.push(m) });
  assert.equal(res.status, 302);
  assert.ok(logged.some((l) => JSON.parse(l).event === "randomization_log_error"));
});

test("compactTimestamp has no separators", () => {
  assert.equal(compactTimestamp(new Date("2026-01-02T03:04:05.678Z")), "20260102T030405Z");
});

test("concurrent duplicate visits log one randomization", async () => {
  const N = 6;
  let reads = 0;
  let open!: () => void;
  const allRead = new Promise<void>((r) => (open = r));
  const store = new MemoryStore({
    afterGet: async () => {
      if (++reads === N) open();
      await allRead;
    },
  });
  const log = new MemoryStore();
  const responses = await Promise.all(
    Array.from({ length: N }, () => handle(new Request("https://x/?email=a"), { ...deps(store), randomizationLog: log })),
  );
  assert.equal(new Set(responses.map((r) => r.headers.get("location"))).size, 1);
  assert.equal(log.data.size, 1);
});

test("with waitUntil, the redirect does not wait for the log write", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const log = new MemoryStore({ beforePut: () => held });
  const pending: Promise<unknown>[] = [];
  const res = await handle(new Request("https://x/?a=1"), {
    ...deps(),
    randomizationLog: log,
    waitUntil: (p) => pending.push(p),
  });
  assert.equal(res.status, 302);
  assert.equal(log.data.size, 0, "write still pending when the response is ready");
  release();
  await Promise.all(pending);
  assert.equal(log.data.size, 1);
});
