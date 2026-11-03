/**
 * AWS Lambda entry for a function URL (or API Gateway HTTP API, payload v2).
 * Credentials come from the function's IAM role via the standard AWS_*
 * environment variables; set S3_BUCKET (and S3_PREFIX if not "map/").
 */
import { handle } from "../core/handler.ts";
import { s3StoreFromEnv } from "../store/s3.ts";
import { buildId, config } from "../generated/config.ts";

interface FunctionUrlEvent {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string }; domainName?: string };
}

interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const host = event.requestContext?.domainName ?? event.headers?.["host"] ?? "localhost";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const request = new Request(`https://${host}${event.rawPath ?? "/"}${query}`, {
    method: event.requestContext?.http?.method ?? "GET",
  });
  const store = s3StoreFromEnv(process.env);
  const response = await handle(request, { store, config, buildId, log: console.log, logLevel: process.env["LOG_LEVEL"] });
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}
