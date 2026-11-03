import type { Config } from "./config.ts";
import { parseQuery } from "./params.ts";
import { resolveDetailed } from "./roulette.ts";
import type { Store } from "../store/types.ts";

export interface HandlerDeps {
  store: Store;
  config: Config;
  /** Identifies the code and config that are live; sent as X-Roulette-Build. */
  buildId: string;
  log?: (message: string) => void;
  /**
   * "error": failures only. "info" (default): one JSON line per redirect,
   * without raw params (they usually carry emails). "debug": adds params.
   */
  logLevel?: string;
}

/**
 * The whole app: GET or HEAD with query params -> 302 to the assigned study.
 * Any path is accepted so the function can sit behind a proxy at /sr or
 * similar.
 */
export async function handle(request: Request, deps: HandlerDeps): Promise<Response> {
  const headers = {
    "x-roulette-build": deps.buildId,
    "cache-control": "no-store",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", {
      status: 405,
      headers: { ...headers, allow: "GET, HEAD" },
    });
  }

  const url = new URL(request.url);
  const params = parseQuery(url.search.slice(1));
  if (params.size === 0) {
    return Response.json({ errors: ["No parameters specified"] }, { status: 404, headers });
  }

  const level = (deps.logLevel ?? "info").toLowerCase();
  const started = Date.now();
  try {
    const r = await resolveDetailed(deps.store, deps.config, params);
    if (level === "info" || level === "debug") {
      const study = r.study === undefined ? undefined : deps.config.studies[r.study];
      deps.log?.(
        JSON.stringify({
          event: "redirect",
          method: request.method,
          outcome: r.outcome,
          key: r.key.slice(0, 12),
          study: study ? (study.note ?? study.url) : undefined,
          ms: Date.now() - started,
          ...(level === "debug" ? { params: Object.fromEntries(params), location: r.url } : {}),
        }),
      );
    }
    return new Response(null, { status: 302, headers: { ...headers, location: r.url } });
  } catch (e) {
    deps.log?.(
      JSON.stringify({
        event: "error",
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
        ms: Date.now() - started,
      }),
    );
    return Response.json({ errors: ["Internal error"] }, { status: 500, headers });
  }
}
