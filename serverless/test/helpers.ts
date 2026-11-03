import type { Config, Study } from "../src/core/config.ts";
import type { Params } from "../src/core/params.ts";

export const FALLBACK = { name: "registry", url: "https://example.com/fallback", note: "registry" };

export function config(studies: Partial<Study>[], seed = "test-seed"): Config {
  return {
    seed,
    studies: studies.map((s, i) => ({ name: `s${i}`, url: "https://example.com/x", weight: 1, required_params: [], ...s })),
    fallback: FALLBACK,
  };
}

export function params(obj: Record<string, string | string[]>): Params {
  return new Map(Object.entries(obj).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
}

/** A promise you can resolve from outside, for interleaving concurrent visits. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}
