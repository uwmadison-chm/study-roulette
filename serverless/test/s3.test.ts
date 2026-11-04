import assert from "node:assert/strict";
import { test } from "node:test";
import { signRequest } from "../src/store/sigv4.ts";
import { S3Store } from "../src/store/s3.ts";

// Worked examples from the AWS S3 SigV4 documentation ("Signature
// Calculations for the Authorization Header: Transferring Payload in a
// Single Chunk").
const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const now = new Date("2013-05-24T00:00:00Z");

test("SigV4 matches the AWS GET Object example", async () => {
  const headers = await signRequest({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    region: "us-east-1",
    headers: { Range: "bytes=0-9" },
    credentials,
    now,
  });
  assert.equal(
    headers["authorization"],
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("SigV4 matches the AWS PUT Object example", async () => {
  const headers = await signRequest({
    method: "PUT",
    url: new URL("https://examplebucket.s3.amazonaws.com/test%24file.text"),
    region: "us-east-1",
    headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
    body: "Welcome to Amazon S3.",
    credentials,
    now,
  });
  assert.ok(
    headers["authorization"]!.endsWith(
      "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    ),
    headers["authorization"],
  );
});

function fakeFetch(responses: number[], seen: { method: string; url: string; headers: Record<string, string> }[]) {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    seen.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers: init?.headers as Record<string, string>,
    });
    const status = responses.shift() ?? 500;
    return new Response(status === 200 ? "https://example.com/a?x=1\n" : "", { status });
  }) as typeof fetch;
}

const store = (responses: number[], seen: any[] = [], pathStyle = true) =>
  new S3Store({
    endpoint: "https://s3.us-east-1.amazonaws.com",
    bucket: "my-bucket",
    region: "us-east-1",
    prefix: "map/",
    pathStyle,
    credentials,
    fetch: fakeFetch(responses, seen),
  });

test("S3Store.get: 200 trims, 404 is null, others throw", async () => {
  assert.equal(await store([200]).get("abc"), "https://example.com/a?x=1");
  assert.equal(await store([404]).get("abc"), null);
  await assert.rejects(store([403]).get("abc"), /403.*ListBucket/);
});

test("S3Store.putIfAbsent sends If-None-Match and maps 200/412", async () => {
  const seen: any[] = [];
  assert.equal(await store([200], seen).putIfAbsent("abc", "v"), true);
  assert.equal(seen[0].method, "PUT");
  assert.equal(seen[0].url, "https://s3.us-east-1.amazonaws.com/my-bucket/map/abc");
  assert.equal(seen[0].headers["if-none-match"], "*");
  assert.match(seen[0].headers["authorization"], /SignedHeaders=.*if-none-match/);
  assert.equal(await store([412]).putIfAbsent("abc", "v"), false);
});

test("S3Store.putIfAbsent retries one 409, then fails on others", async () => {
  assert.equal(await store([409, 200]).putIfAbsent("abc", "v"), true);
  await assert.rejects(store([409, 409]).putIfAbsent("abc", "v"), /409/);
  await assert.rejects(store([500]).putIfAbsent("abc", "v"), /500/);
});

test("virtual-hosted style URLs", () => {
  assert.equal(
    String(store([], [], false).objectUrl("abc")),
    "https://my-bucket.s3.us-east-1.amazonaws.com/map/abc",
  );
});
