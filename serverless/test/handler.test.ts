import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/core/handler.ts";
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

test("fallback assignments are logged under the fallback's name", async () => {
  const logged: string[] = [];
  const c = config([{ url: "https://example.com/a", required_params: ["email"] }]);
  await handle(new Request("https://x/?id=1"), { store: new MemoryStore(), config: c, buildId: "b", log: (m) => logged.push(m) });
  const line = JSON.parse(logged[0]!);
  assert.equal(line.outcome, "fallback_created");
  assert.equal(line.study, "registry");
});
