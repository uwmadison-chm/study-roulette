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
  /**
   * Where to record randomizations: one zero-byte object per new assignment,
   * keyed <study name>/<YYYYMMDDTHHMMSSZ>_<random>. Reports are made by
   * listing keys. Omit to disable.
   */
  randomizationLog?: Store;
  /**
   * Lets background work (the randomization log write) finish after the
   * response is sent, e.g. a Workers ExecutionContext's waitUntil. Without
   * it, the handler waits for the write before responding; that is the
   * safe choice on Lambda, which freezes once the handler returns.
   */
  waitUntil?: (work: Promise<unknown>) => void;
  /** For tests. */
  now?: () => Date;
}

/** 2026-11-03T16:42:31.123Z -> 20261103T164231Z: sortable, and no colons for Windows or macOS. */
export function compactTimestamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function randomSuffix(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Record one randomization. Keys are unique per write, so a conflict only means a random collision. */
export async function recordRandomization(store: Store, name: string, at: Date): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = `${name}/${compactTimestamp(at)}_${randomSuffix()}`;
    if (await store.putIfAbsent(key, "")) return key;
  }
  throw new Error(`could not record randomization for ${name}`);
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
    if (deps.randomizationLog && (r.outcome === "created" || r.outcome === "fallback_created")) {
      const name = r.study === undefined ? deps.config.fallback.name : deps.config.studies[r.study]!.name;
      // The assignment is stored; a missing log entry must not break the redirect
      const write = recordRandomization(deps.randomizationLog, name, deps.now?.() ?? new Date()).catch((e) => {
        deps.log?.(
          JSON.stringify({
            event: "randomization_log_error",
            study: name,
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      });
      if (deps.waitUntil) deps.waitUntil(write);
      else await write;
    }
    if (level === "info" || level === "debug") {
      const study = r.study === undefined ? undefined : deps.config.studies[r.study];
      deps.log?.(
        JSON.stringify({
          event: "redirect",
          method: request.method,
          outcome: r.outcome,
          key: r.key.slice(0, 12),
          study: study?.name ?? (r.outcome === "fallback_created" ? deps.config.fallback.name : undefined),
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
