/**
 * Confirm the configured bucket supports atomic conditional creates
 * (PUT If-None-Match: *). Run before deploying; a store that ignores the
 * header would silently reintroduce the duplicate-visit race.
 *
 *   S3_BUCKET=... [S3_ENDPOINT=...] [S3_REGION=...] node scripts/check-store.ts
 *
 * Writes a few small objects under check/ and leaves them; they are harmless.
 */
import { s3StoreFromEnv } from "../src/store/s3.ts";

const store = s3StoreFromEnv(process.env, { prefix: "check/" });
const run = `${Date.now()}-${crypto.randomUUID()}`;
const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const key = `${run}-single`;
if (!(await store.putIfAbsent(key, "first"))) fail("first conditional create was refused");
if (await store.putIfAbsent(key, "second")) fail("second conditional create succeeded: the store ignores If-None-Match");
if ((await store.get(key)) !== "first") fail("stored value was overwritten");
if ((await store.get(`${run}-missing`)) !== null) fail("missing key did not read as absent");

const raceKey = `${run}-race`;
const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.putIfAbsent(raceKey, `writer-${i}`)));
const winners = results.filter(Boolean).length;
if (winners !== 1) fail(`${winners} of 10 concurrent creates succeeded; expected exactly 1`);

console.log("OK: conditional creates are atomic on this store");
