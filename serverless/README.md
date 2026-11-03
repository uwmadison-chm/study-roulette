# Study Roulette, serverless

A TypeScript port of Study Roulette that runs as a single serverless function with an S3-compatible bucket as its only dependency. It behaves like the Python app in the repository root and reads the same stored mappings, so existing `LOOKUP_DIR` files migrate as-is.

- **No runtime dependencies.** Web-standard APIs only (`fetch`, `URL`, WebCrypto). Bundles are about 15 KB.
- **Safe under duplicate visits.** Mappings are write-once objects created with `PUT If-None-Match: *`, and the study choice is seeded from a hash of the link's params, so a link scanner and a person opening the same link at the same moment always end up at the same study.
- **Routing is part of the build.** `studies.json` is validated and compiled in; an invalid config fails the build. Edit it with the configurator rather than by hand.
- **Portable.** The same code runs on AWS Lambda, Cloudflare Workers, or a plain Node server, against AWS S3, Cloudflare R2, or MinIO.

## How it works

On each `GET` or `HEAD` with query params:

1. Compute the candidate storage keys (SHA-256 of canonical JSON of the params, exactly as the Python version does) and read them all in parallel. If any exists, redirect there, merging in the current params (stored values win).
2. Otherwise pick a study: eligible studies are those whose `required_params` are all present; the weighted choice is driven by `SHA-256(seed + "\n" + canonical params)`, so identical links always pick the same study.
3. Create the mapping with a conditional `PUT`. If another visit created it first (412), read theirs and redirect there instead.

Responses are `302` with `Location`, `Cache-Control: no-store`, and `X-Roulette-Build: <git sha>-<config hash>` so `curl -I` shows which code and routing are live. No params is `404`; storage failures are `500`.

Requests on any path are handled, so the function can sit behind a proxy at `/sr` or similar.

## Configuration

Routing lives in `studies.json`:

```json
{
  "seed": "3f1c9a…",
  "studies": [
    {"name": "control", "url": "https://redcap.example.edu/surveys/?s=12345678", "weight": 1, "note": "Control", "required_params": ["email"], "key_params": ["email"]},
    {"name": "treatment", "url": "https://redcap.example.edu/surveys/?s=abcdef12", "weight": 2, "note": "Treatment", "required_params": ["email", "ts"], "key_params": ["email"]}
  ],
  "fallback": {"url": "https://redcap.example.edu/surveys/?s=fa11back", "note": "Registry"}
}
```

Semantics of `weight`, `required_params`, `key_params`, and `fallback` are unchanged from the Python version (see the root README). `seed` is not a secret; it only changes which study never-visited links land on. Each study's `name` (1-64 characters of `a-z`, `0-9`, `_`, `-`; unique; `fallback` is reserved) identifies it in logs and the randomization log.

### Configurator

`npm run build` writes a static page to `dist/configurator/`. Open `index.html` directly or host it anywhere (GitHub Pages works); it makes no network requests. It:

- loads a `studies.json` and validates it with the same code the build uses,
- previews a sample link: eligibility, chances, the exact study an unvisited link will get, and its storage key,
- warns about edits that would re-randomize already-assigned people (a `key_params` set no study uses anymore),
- downloads the result for you to commit.

### Converting a Python-era `studies.toml`

```sh
python3 scripts/toml_to_json.py ../path/to/studies.toml > studies.json
```

## Storage settings

| Variable | Meaning | Default |
| --- | --- | --- |
| `S3_BUCKET` | Bucket name | required |
| `S3_ENDPOINT` | S3 API endpoint | `https://s3.<region>.amazonaws.com` |
| `S3_REGION` | Signing region (`auto` for R2) | `AWS_REGION`, else `us-east-1` |
| `S3_PREFIX` | Key prefix for mappings | `map/` |
| `S3_PATH_STYLE` | `false` for virtual-hosted URLs | `true` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN` | Credentials | the standard `AWS_*` variables (Lambda's IAM role) |
| `LOG_LEVEL` | `error`, `info`, or `debug` | `info` |
| `LOG_S3_BUCKET` | Bucket for the randomization log; unset disables it | unset |
| `LOG_S3_PREFIX` | Key prefix within the log bucket | none |

The store must support atomic `If-None-Match: *` on `PutObject`. AWS S3, Cloudflare R2, and MinIO do; Backblaze B2 does not. Check a bucket before deploying:

```sh
S3_BUCKET=… S3_ENDPOINT=… node scripts/check-store.ts
```

## Logging

Logs go to stdout (CloudWatch Logs on Lambda, Workers Logs or `wrangler tail` on Cloudflare). At `info`, each redirect writes one JSON line without the raw params, since they usually carry emails:

```json
{"event":"redirect","method":"GET","outcome":"created","key":"57499226b526","study":"treatment","ms":41}
```

`outcome` is `existing`, `created`, `fallback_created`, or `race_lost` (a concurrent visit created the mapping first). `debug` adds `params` and `location`. Errors are always logged.

## Randomization log

With `LOG_S3_BUCKET` set, every new assignment also writes a zero-byte object to that bucket:

```
<study name>/<YYYYMMDDTHHMMSSZ>_<random>
control/20261103T164231Z_9f2c41ab
fallback/20261103T170002Z_03d1e7c4
```

The key is the whole record, so a report is just a listing, and keys sort by time within each study. Returning visitors and visits that lose a race don't write an entry, so there is exactly one entry per stored mapping. The timestamps have no colons, so `aws s3 sync` to macOS or Windows works.

It lives in its own bucket so reporting credentials only need `s3:ListBucket` on the log bucket and never touch mappings, which hold destination URLs with participants' params. A failed log write is logged as `randomization_log_error` but doesn't stop the redirect.

```sh
LOG_S3_BUCKET=… node scripts/report.ts                   # counts per study
LOG_S3_BUCKET=… node scripts/report.ts --since 20261101  # any prefix of YYYYMMDDTHHMMSSZ; --until too
LOG_S3_BUCKET=… node scripts/report.ts --csv > log.csv   # timestamp,study rows
```

```
control       412   33.4%
treatment     820   66.6%
total        1232

20261001T140112Z to 20261103T164231Z
```

Or `aws s3 ls --recursive s3://<log bucket>/` and count with your usual tools.

## Deploying

```sh
npm ci
cp /path/to/studies.json .
npm run build
```

### AWS Lambda

1. Create a bucket. Give the function's role `s3:GetObject` and `s3:PutObject` on `arn:aws:s3:::<bucket>/map/*`, plus `s3:ListBucket` on the bucket (without it, a missing object reads as 403 instead of 404). For the randomization log, create a second bucket and give the role only `s3:PutObject` on it; give report users only `s3:ListBucket` on it.
2. Create a Node.js 22 function with handler `index.handler`, upload `dist/lambda/index.mjs` zipped (`cd dist/lambda && zip ../lambda.zip index.mjs`), and set `S3_BUCKET`.
3. Add a function URL (auth type `NONE`), or put it behind CloudFront or API Gateway for a custom domain.

### Cloudflare Workers + R2

1. Create an R2 bucket and an R2 API token with object read/write on it.
2. Copy `wrangler.example.toml` to `wrangler.toml` and fill in the account id and bucket.
3. Set the token as secrets and deploy (commands are in the example file).

This uses R2's S3 API, so storage code is identical to AWS.

### Local

```sh
npm run dev   # http://localhost:8787, in-memory store unless S3_BUCKET is set
```

## Migrating from the Python version

Stored mappings are plain-text objects named by the same hash, so:

1. Deploy, and test on the new URL.
2. Stop the Python server, then copy its files: `aws s3 sync "$LOOKUP_DIR" s3://<bucket>/map/` (or `rclone copy`).
3. Point the recruitment link at the new URL.

## Development

```sh
npm test          # unit, race, and Python-compatibility tests
npm run typecheck
npm run golden    # regenerate test/golden.json from the Python implementation
npm run test:props  # property tests (local only; needs uv for the Python oracle)
```

`npm run test:props` runs [fast-check](https://fast-check.dev/) properties that are kept out of `npm test` and CI:

- **Python parity** (`test/parity.prop.ts`): random query strings (percent-escapes of every byte, invalid UTF-8, `+`, `=`, `&`, astral characters) and base URLs go through both implementations, with the Python code running as a subprocess oracle; parsed params, hashes, and merged URLs must match exactly. Failures shrink to a minimal query.
- **Core properties** (`test/properties.prop.ts`): hashing ignores param and value order, `urlencode`/`parseQuery` round-trip, merge precedence and idempotence, the seeded choice always picks an eligible weighted study, stored assignments never change, and concurrent identical visits under any interleaving (fast-check's scheduler) store exactly one mapping.

The default is a few thousand cases and takes about 5 seconds; `PROP_RUNS=50000 npm run test:props` searches longer.

`test/golden.json` holds query parsing, hashing, and URL merging results produced by the Python code; the TypeScript must match them byte for byte, or existing participants would be re-randomized. CI also runs `check-store` against a real MinIO.
