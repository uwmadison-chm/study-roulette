/**
 * Cloudflare Workers entry. R2 is reached through its S3 API so the storage
 * code is identical to AWS; set S3_ENDPOINT to
 * https://<account-id>.r2.cloudflarestorage.com, S3_REGION to "auto", and the
 * R2 API token's key pair as the S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 * secrets.
 */
import { handle } from "../core/handler.ts";
import { s3StoreFromEnv } from "../store/s3.ts";
import { buildId, config } from "../generated/config.ts";

export default {
  async fetch(request: Request, env: Record<string, string | undefined>): Promise<Response> {
    const store = s3StoreFromEnv(env);
    return handle(request, { store, config, buildId, log: console.log, logLevel: env["LOG_LEVEL"] });
  },
};
