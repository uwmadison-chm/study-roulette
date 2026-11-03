/**
 * Confirm the configured bucket supports atomic conditional creates
 * (PUT If-None-Match: *). Run before deploying; a store that ignores the
 * header would silently reintroduce the duplicate-visit race.
 *
 *   S3_BUCKET=... [S3_ENDPOINT=...] [S3_REGION=...] node scripts/check-store.ts
 *
 * Writes a few small objects under check/ and leaves them; they are harmless.
 * --create-bucket creates S3_BUCKET first (for a fresh MinIO in CI).
 */
import { s3StoreFromEnv } from "../src/store/s3.ts";
import { signRequest } from "../src/store/sigv4.ts";

const store = s3StoreFromEnv(process.env, { prefix: "check/" });

if (process.argv.includes("--create-bucket")) {
  const url = new URL(store.objectUrl("x").href.replace(/\/check\/x$/, ""));
  const env = process.env;
  const headers = await signRequest({
    method: "PUT",
    url,
    region: env["S3_REGION"] ?? "us-east-1",
    credentials: {
      accessKeyId: env["S3_ACCESS_KEY_ID"] ?? env["AWS_ACCESS_KEY_ID"] ?? "",
      secretAccessKey: env["S3_SECRET_ACCESS_KEY"] ?? env["AWS_SECRET_ACCESS_KEY"] ?? "",
    },
  });
  const res = await fetch(url, { method: "PUT", headers });
  if (res.status !== 200 && res.status !== 409) {
    console.error(`FAIL: could not create bucket: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
}
const run = `${Date.now()}-${crypto.randomUUID()}`;
const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const key = `${run}-single`;
if (!(await store.putIfAbsent(key, "first"))) fail("first conditional create was refused");
if (await store.putIfAbsent(key, "second")) fail("second conditional create succeeded: the store ignores If-None-Match");
const entry = await store.get(key);
if (entry?.value !== "first") fail("stored value was overwritten");
if (!entry?.created || Math.abs(entry.created - Date.now()) > 10 * 60 * 1000) fail(`creation time not read back (${entry?.created})`);
if ((await store.get(`${run}-missing`)) !== null) fail("missing key did not read as absent");

const raceKey = `${run}-race`;
const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.putIfAbsent(raceKey, `writer-${i}`)));
const winners = results.filter(Boolean).length;
if (winners !== 1) fail(`${winners} of 10 concurrent creates succeeded; expected exactly 1`);

console.log("OK: conditional creates are atomic on this store");
