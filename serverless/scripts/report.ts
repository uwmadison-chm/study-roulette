/**
 * Summarize randomizations from the log bucket by listing its keys
 * (<study>/<YYYYMMDDTHHMMSSZ>_<random>). Needs only s3:ListBucket on the log
 * bucket, never access to the mapping bucket.
 *
 *   LOG_S3_BUCKET=... [S3_ENDPOINT=... S3_REGION=...] node scripts/report.ts [options]
 *
 * Options:
 *   --since 20261101         only entries at or after this time (any prefix of YYYYMMDDTHHMMSSZ)
 *   --until 20261201         only entries before this time
 *   --study control          only this study
 *   --csv                    print timestamp,study rows instead of counts
 */
import { parseArgs } from "node:util";
import { logStoreFromEnv } from "../src/store/s3.ts";

const { values: args } = parseArgs({
  options: {
    since: { type: "string" },
    until: { type: "string" },
    study: { type: "string" },
    csv: { type: "boolean", default: false },
  },
});

const store = logStoreFromEnv(process.env);
if (!store) {
  console.error("Set LOG_S3_BUCKET (and S3_ENDPOINT / S3_REGION / credentials as for the function).");
  process.exit(1);
}

const KEY = /^([a-z0-9_-]+)\/(\d{8}T\d{6}Z)_[0-9a-f]+$/;
const counts = new Map<string, number>();
let first: string | undefined;
let last: string | undefined;
if (args.csv) console.log("timestamp,study");

for await (const key of store.listKeys(args.study ? `${args.study}/` : "")) {
  const m = KEY.exec(key);
  if (!m) continue;
  const [, study, stamp] = m as unknown as [string, string, string];
  if (args.since && stamp < args.since) continue;
  if (args.until && stamp >= args.until) continue;
  if (args.csv) console.log(`${stamp},${study}`);
  counts.set(study, (counts.get(study) ?? 0) + 1);
  if (!first || stamp < first) first = stamp;
  if (!last || stamp > last) last = stamp;
}

if (!args.csv) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const width = Math.max(5, ...[...counts.keys()].map((k) => k.length));
  for (const [study, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const pct = total ? ((100 * n) / total).toFixed(1) : "0.0";
    console.log(`${study.padEnd(width)}  ${String(n).padStart(7)}  ${pct.padStart(5)}%`);
  }
  console.log(`${"total".padEnd(width)}  ${String(total).padStart(7)}`);
  if (first) console.log(`\n${first} to ${last}`);
}
