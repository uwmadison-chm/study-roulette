import { encodeSegment, signRequest, type Credentials } from "./sigv4.ts";
import type { Entry, Store } from "./types.ts";

export interface S3StoreOptions {
  /** e.g. https://s3.us-east-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  /** "auto" for R2 */
  region: string;
  credentials: Credentials;
  /** Key prefix, e.g. "map/". */
  prefix?: string;
  /** Use https://endpoint/bucket/key instead of https://bucket.endpoint/key. Default true. */
  pathStyle?: boolean;
  fetch?: typeof fetch;
}

export class S3Error extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * A Store over any S3-compatible API that supports conditional creates
 * (PUT with If-None-Match: *): AWS S3, Cloudflare R2, MinIO.
 */
export class S3Store implements Store {
  private readonly opts: S3StoreOptions;
  private readonly fetch: typeof fetch;

  constructor(opts: S3StoreOptions) {
    this.opts = opts;
    this.fetch = opts.fetch ?? fetch.bind(globalThis);
  }

  objectUrl(key: string): URL {
    const base = new URL(this.opts.endpoint);
    const path = `${this.opts.prefix ?? ""}${key}`.split("/").map(encodeSegment).join("/");
    if (this.opts.pathStyle ?? true) {
      const basePath = base.pathname.replace(/\/$/, "");
      return new URL(`${base.protocol}//${base.host}${basePath}/${encodeSegment(this.opts.bucket)}/${path}`);
    }
    return new URL(`${base.protocol}//${this.opts.bucket}.${base.host}/${path}`);
  }

  private async send(method: string, key: string, body?: string, headers?: Record<string, string>) {
    const url = this.objectUrl(key);
    const signed = await signRequest({
      method,
      url,
      region: this.opts.region,
      headers,
      body,
      credentials: this.opts.credentials,
    });
    return this.fetch(url, { method, headers: signed, body });
  }

  /**
   * List keys under this store's prefix plus `within`, oldest-first within a
   * prefix since keys sort lexicographically. Returns keys without the store
   * prefix. Pages through ListObjectsV2 1,000 keys at a time.
   */
  async *listKeys(within = ""): AsyncGenerator<string> {
    const prefix = `${this.opts.prefix ?? ""}${within}`;
    const root = this.bucketRoot();
    let token: string | undefined;
    do {
      const url = new URL(root);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      if (token) url.searchParams.set("continuation-token", token);
      const signed = await signRequest({ method: "GET", url, region: this.opts.region, credentials: this.opts.credentials });
      const res = await this.fetch(url, { method: "GET", headers: signed });
      const body = await res.text();
      if (res.status !== 200) throw new S3Error(`S3 LIST ${prefix} failed: ${res.status} ${body.slice(0, 300)}`, res.status);
      for (const m of body.matchAll(/<Key>([^<]*)<\/Key>/g)) yield decodeXml(m[1]!).slice((this.opts.prefix ?? "").length);
      token = /<IsTruncated>true<\/IsTruncated>/.test(body)
        ? decodeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(body)?.[1] ?? "")
        : undefined;
    } while (token);
  }

  private bucketRoot(): string {
    const base = new URL(this.opts.endpoint);
    if (this.opts.pathStyle ?? true) {
      const basePath = base.pathname.replace(/\/$/, "");
      return `${base.protocol}//${base.host}${basePath}/${encodeSegment(this.opts.bucket)}`;
    }
    return `${base.protocol}//${this.opts.bucket}.${base.host}/`;
  }

  async get(key: string): Promise<Entry | null> {
    const res = await this.send("GET", key);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (res.status !== 200) {
      const detail = (await res.text()).slice(0, 300);
      const hint =
        res.status === 403
          ? " (on AWS, a missing object returns 403 unless the role has s3:ListBucket)"
          : "";
      throw new S3Error(`S3 GET ${key} failed: ${res.status}${hint} ${detail}`, res.status);
    }
    const value = (await res.text()).trim();
    if (!value) return null;
    // Our own writes record the creation time in ms; otherwise (e.g. objects
    // copied in without it) fall back to Last-Modified
    const meta = Number(res.headers.get("x-amz-meta-created"));
    const modified = Date.parse(res.headers.get("last-modified") ?? "");
    const created = Number.isFinite(meta) && meta > 0 ? meta : Number.isFinite(modified) ? modified : undefined;
    return created === undefined ? { value } : { value, created };
  }

  async putIfAbsent(key: string, value: string, created: number = Date.now()): Promise<boolean> {
    // 409 means a concurrent delete raced us (AWS); one retry is enough
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.send("PUT", key, value, {
        "content-type": "text/plain; charset=utf-8",
        "if-none-match": "*",
        "x-amz-meta-created": String(Math.round(created)),
      });
      const detail = res.status === 200 ? "" : (await res.text()).slice(0, 300);
      if (res.status === 200) {
        await res.body?.cancel();
        return true;
      }
      if (res.status === 412) return false;
      if (res.status === 409 && attempt === 0) continue;
      throw new S3Error(`S3 conditional PUT ${key} failed: ${res.status} ${detail}`, res.status);
    }
    throw new S3Error(`S3 conditional PUT ${key} kept conflicting`, 409);
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/**
 * The randomization log store, or null when LOG_S3_BUCKET is unset. It is a
 * separate bucket so reporting credentials never need access to mappings.
 * Endpoint, region and credentials are shared with the mapping store.
 */
export function logStoreFromEnv(env: Record<string, string | undefined>): S3Store | null {
  const bucket = env["LOG_S3_BUCKET"];
  if (!bucket) return null;
  return s3StoreFromEnv({ ...env, S3_BUCKET: bucket }, { prefix: env["LOG_S3_PREFIX"] ?? "" });
}

/** Build an S3Store from environment-style variables. */
export function s3StoreFromEnv(
  env: Record<string, string | undefined>,
  overrides: Partial<S3StoreOptions> = {},
): S3Store {
  const need = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`missing required setting ${name}`);
    return v;
  };
  const region = env["S3_REGION"] ?? env["AWS_REGION"] ?? "us-east-1";
  const opts: S3StoreOptions = {
    endpoint: env["S3_ENDPOINT"] ?? `https://s3.${region}.amazonaws.com`,
    bucket: need("S3_BUCKET"),
    region,
    prefix: env["S3_PREFIX"] ?? "map/",
    pathStyle: (env["S3_PATH_STYLE"] ?? "true") !== "false",
    credentials: {
      accessKeyId: env["S3_ACCESS_KEY_ID"] ?? need("AWS_ACCESS_KEY_ID"),
      secretAccessKey: env["S3_SECRET_ACCESS_KEY"] ?? need("AWS_SECRET_ACCESS_KEY"),
    },
  };
  const token = env["S3_SESSION_TOKEN"] ?? (env["S3_ACCESS_KEY_ID"] ? undefined : env["AWS_SESSION_TOKEN"]);
  if (token) opts.credentials.sessionToken = token;
  return new S3Store({ ...opts, ...overrides });
}
