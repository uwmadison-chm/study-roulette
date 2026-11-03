// Differential test: the TypeScript parsing, hashing and merging must agree
// with the Python implementation on arbitrary input, or existing participants
// would be re-randomized after migration. Runs the Python code as an oracle
// subprocess; needs `uv` and the repo's Python package. Run with
// `npm run test:props` (not part of `npm test` or CI).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import fc from "fast-check";
import { computeHash } from "../src/core/hash.ts";
import { parseQuery } from "../src/core/params.ts";
import { mergeUrl } from "../src/core/urls.ts";
import { anyQuery, baseUrl } from "./arbitraries.ts";

const NUM_RUNS = Number(process.env["PROP_RUNS"] ?? 3000);

let ask: (req: unknown) => Promise<any>;
let stop: () => void;

before(() => {
  const repoRoot = new URL("../..", import.meta.url).pathname;
  const proc = spawn("uv", ["run", "--quiet", "python", "serverless/scripts/parity_oracle.py"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  let queue = Promise.resolve();
  ask = (req) => {
    const result = queue.then(async () => {
      proc.stdin.write(JSON.stringify(req) + "\n");
      const { value, done } = await lines.next();
      if (done) throw new Error("Python oracle exited");
      return JSON.parse(value);
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  stop = () => proc.stdin.end();
});

after(() => stop());

test("parsing, hashing and merging match Python on arbitrary queries", async () => {
  await fc.assert(
    fc.asyncProperty(anyQuery, fc.array(baseUrl, { minLength: 1, maxLength: 3 }), async (query, bases) => {
      const py = await ask({ query, bases });
      assert.equal(py.error, undefined, py.error);
      const params = parseQuery(query);
      assert.deepEqual([...params], py.params, "parsed params");
      assert.equal(await computeHash(params), py.hash, "hash");
      assert.deepEqual(
        bases.map((b) => mergeUrl(b, params)),
        py.merges,
        "merged URLs",
      );
    }),
    { numRuns: NUM_RUNS },
  );
});
