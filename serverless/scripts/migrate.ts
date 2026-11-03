/**
 * Copy the Python version's LOOKUP_DIR mappings into the bucket, keeping
 * each file's modification time as the mapping's creation time so "oldest
 * mapping wins" sees the original order.
 *
 *   S3_BUCKET=... [S3_ENDPOINT=...] [S3_REGION=...] node scripts/migrate.ts <LOOKUP_DIR>
 *
 * Uses conditional creates, so it never overwrites a mapping already in the
 * bucket and is safe to re-run. Files not named by a hash are skipped.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { s3StoreFromEnv } from "../src/store/s3.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/migrate.ts <LOOKUP_DIR>");
  process.exit(2);
}

const store = s3StoreFromEnv(process.env);
const names = (await readdir(dir)).filter((n) => /^[0-9a-f]{64}$/.test(n));
const counts = { created: 0, existing: 0, empty: 0, conflicting: 0 };

async function migrate(name: string): Promise<void> {
  const path = join(dir!, name);
  const value = (await readFile(path, "utf8")).trim();
  if (!value) {
    counts.empty++;
    return;
  }
  const { mtimeMs } = await stat(path);
  if (await store.putIfAbsent(name, value + "\n", mtimeMs)) {
    counts.created++;
    return;
  }
  counts.existing++;
  const stored = await store.get(name);
  if (stored?.value !== value) {
    counts.conflicting++;
    console.warn(`conflict: ${name} differs in the bucket; kept the bucket's\n  file:   ${value}\n  bucket: ${stored?.value}`);
  }
}

// A few requests in flight at a time
const queue = [...names];
await Promise.all(
  Array.from({ length: 16 }, async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) await migrate(name);
  }),
);

console.log(
  `${names.length} mappings: ${counts.created} created, ${counts.existing} already present ` +
    `(${counts.conflicting} conflicting), ${counts.empty} empty files skipped`,
);
if (counts.conflicting > 0) process.exit(1);
