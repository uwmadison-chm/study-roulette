import { parseQuery, type Params } from "./params.ts";

const ALWAYS_SAFE = /[A-Za-z0-9_.\-~]/;

/** Python's urllib.parse.quote_plus with its default safe set. */
export function quotePlus(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === " ") out += "+";
    else if (ALWAYS_SAFE.test(ch)) out += ch;
    else
      for (const b of new TextEncoder().encode(ch))
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** Python's urlencode(params, doseq=True). */
export function urlencode(params: Params): string {
  const parts: string[] = [];
  for (const [name, values] of params) {
    for (const v of values) parts.push(`${quotePlus(name)}=${quotePlus(v)}`);
  }
  return parts.join("&");
}

/** Split a URL into [before-query, query, fragment] (query/fragment without ?/#). */
function splitUrl(url: string): [string, string | null, string | null] {
  let fragment: string | null = null;
  const hash = url.indexOf("#");
  if (hash !== -1) {
    fragment = url.slice(hash + 1);
    url = url.slice(0, hash);
  }
  let query: string | null = null;
  const q = url.indexOf("?");
  if (q !== -1) {
    query = url.slice(q + 1);
    url = url.slice(0, q);
  }
  // urlparse lowercases the scheme
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z][A-Za-z0-9+.\-]*$/.test(url.slice(0, colon))) {
    url = url.slice(0, colon).toLowerCase() + url.slice(colon);
  }
  return [url, query, fragment];
}

/**
 * Merge incoming params into a base URL; the base URL's params win any
 * conflict. Mirrors the Python merge_urls: incoming keys first in their
 * order, base values replacing in place, base-only keys appended.
 */
export function mergeUrl(baseUrl: string, incoming: Params): string {
  const [head, query, fragment] = splitUrl(baseUrl);
  const merged: Params = new Map(incoming);
  for (const [name, values] of parseQuery(query ?? "")) merged.set(name, values);
  const newQuery = urlencode(merged);
  let out = head;
  if (newQuery) out += "?" + newQuery;
  if (fragment) out += "#" + fragment;
  return out;
}
