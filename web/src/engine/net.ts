// The ONLY fetch site in web/src (docs/PLAN.md rule 1; scripts/check-network.sh enforces it).
//
// Every request our code or Transformers.js makes goes through guardedFetch(), which allows
// exactly three kinds of URL, all derived from spec/ (never hand-typed here):
//   1. same-origin paths (the built app, /ort/*, /models/*, /demo/*),
//   2. exact pinned Hub file URLs: spec/models.json files × url_template, at the pinned revision,
//   3. the Hub's redirect targets recorded by S1-00b in spec/network.json (hosts, host patterns,
//      and the query parameter names the redirect carries), and only for a pinned file.
// Anything else, including any `/resolve/main/` URL or a query string on a Hub file URL, is
// rejected before the request leaves the page. The privacy test (S1-12) records what the browser
// actually sent; the generated CSP `connect-src` (scripts/csp.mjs, from cspConnectSrc()) makes the
// browser itself refuse everything off this list.
import network from "../../../spec/network.json";
import { pinnedFileUrls } from "./pins";

export type Decision =
  | { ok: true; kind: "same-origin" | "exact" | "redirect"; url: URL }
  | { ok: false; reason: string; url: URL | null };

export class NetworkPolicyError extends Error {
  constructor(public readonly reason: string, public readonly url: string) {
    super(`network policy: ${reason}`);
    this.name = "NetworkPolicyError";
  }
}

interface WebPolicy {
  redirect_hosts?: string[];
  redirect_host_patterns?: string[];
  /** per host, the query parameter names a redirect target may carry (S1-00b observed them) */
  redirect_query_params?: Record<string, string[] | string>;
  hub_files?: Record<string, unknown> & { url_template?: string };
}

function webPolicy(): WebPolicy {
  return ((network as unknown as { web?: WebPolicy }).web ?? {}) as WebPolicy;
}

/** Counters for the stats row (numbers only, never URLs). */
export const netStats = { allowed: 0, rejected: 0, redirect_rejected: 0 };

let exactSet: Set<string> | null = null;
/** Exact pinned file URLs, built once from spec/models.json plus every `observed_*` list in network.json. */
export function exactUrls(): Set<string> {
  if (!exactSet) {
    const observed: string[] = [];
    for (const [k, v] of Object.entries(webPolicy().hub_files ?? {})) {
      if (k.startsWith("observed") && Array.isArray(v)) observed.push(...(v as string[]));
    }
    exactSet = new Set([...pinnedFileUrls(), ...observed]);
  }
  return exactSet;
}

function hostAllowed(host: string): boolean {
  const p = webPolicy();
  if ((p.redirect_hosts ?? []).includes(host)) return true;
  for (const pat of p.redirect_host_patterns ?? []) {
    if (pat.startsWith("*.") && host.endsWith(pat.slice(1)) && host.length > pat.length - 1) return true;
  }
  return false;
}

function patternFor(host: string): string | null {
  for (const pat of webPolicy().redirect_host_patterns ?? []) {
    if (pat.startsWith("*.") && host.endsWith(pat.slice(1)) && host.length > pat.length - 1) return pat;
  }
  return null;
}

/** Recorded query parameter names for a redirect host; hosts under the same pattern share them. */
function paramsFor(host: string): Set<string> {
  const table = webPolicy().redirect_query_params ?? {};
  if (Array.isArray(table[host])) return new Set(table[host]);
  const pat = patternFor(host);
  const out = new Set<string>();
  if (pat) {
    for (const [h, names] of Object.entries(table)) {
      if (Array.isArray(names) && patternFor(h) === pat) names.forEach((n) => out.add(n));
    }
  }
  return out;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Does `url` look like the Hub's redirect target for one of our pinned files? */
function redirectAllowed(url: URL): { ok: boolean; reason?: string } {
  if (!hostAllowed(url.host)) return { ok: false, reason: "host not in redirect_hosts" };
  const allowedParams = paramsFor(url.host);
  const pinnedPaths = [...exactUrls()].map((u) => new URL(u).pathname); // /<id>/resolve/<sha>/<file>
  let matched: string | null = null;
  // Form A: same host as the Hub, cache path /api/resolve-cache/models/<id>/<sha>/<file>
  for (const p of pinnedPaths) {
    const m = p.match(/^\/(.+)\/resolve\/([0-9a-f]{40})\/(.+)$/);
    if (!m) continue;
    const cachePath = `/api/resolve-cache/models/${m[1]}/${m[2]}/${m[3]}`;
    if (url.pathname === cachePath) matched = p;
  }
  // Form B: CDN bridge; the file name travels in response-content-disposition.
  const disposition = url.searchParams.get("response-content-disposition");
  if (!matched && disposition) {
    const fname = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    if (fname) {
      const hit = pinnedPaths.find((p) => basename(p) === decodeURIComponent(fname));
      if (hit) matched = hit;
    }
  }
  if (!matched) return { ok: false, reason: "redirect target is not a pinned file" };
  for (const key of url.searchParams.keys()) {
    if (allowedParams.has(key)) continue;
    // Form A carries the URL-encoded original path as a parameter *name*.
    if (decodeURIComponent(key) === matched) continue;
    return { ok: false, reason: "redirect query parameter not recorded" };
  }
  return { ok: true };
}

/** Decide whether a URL may be fetched. Pure; no request is made. */
export function allowedUrl(input: string | URL, base?: string): Decision {
  let url: URL;
  try {
    url = new URL(input, base ?? (typeof location !== "undefined" ? location.origin : undefined));
  } catch {
    return { ok: false, reason: "unparseable url", url: null };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "scheme", url };
  const origin = typeof location !== "undefined" ? location.origin : null;
  if (origin && url.origin === origin) {
    if (url.search) return { ok: false, reason: "query string on same-origin path", url };
    return { ok: true, kind: "same-origin", url };
  }
  if (/\/resolve\/main\//.test(url.pathname)) return { ok: false, reason: "unpinned revision", url };
  if (exactUrls().has(url.href)) return { ok: true, kind: "exact", url };
  if (url.search === "" && exactUrls().has(url.origin + url.pathname)) return { ok: true, kind: "exact", url };
  const r = redirectAllowed(url);
  if (r.ok) return { ok: true, kind: "redirect", url };
  return { ok: false, reason: r.reason ?? "not allowed", url };
}

/**
 * fetch() behind the allowlist. Rejects with NetworkPolicyError before any request for a URL
 * that is not allowed, and after the response if the browser followed a redirect somewhere
 * that is not a recorded target for that file.
 */
export async function guardedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const d = allowedUrl(input);
  if (!d.ok) {
    netStats.rejected++;
    throw new NetworkPolicyError(d.reason, d.url ? d.url.origin + d.url.pathname : "invalid");
  }
  if (init?.method && init.method.toUpperCase() !== "GET") {
    netStats.rejected++;
    throw new NetworkPolicyError("only GET", d.url.origin + d.url.pathname);
  }
  netStats.allowed++;
  const res = await fetch(d.url, { ...init, method: "GET", credentials: "omit", referrerPolicy: "no-referrer" });
  // When the COI service worker controls the page it hands back a constructed Response whose
  // `url` is empty; it carries the fetched response's final URL in a header instead (see
  // public/coi-serviceworker.js). Either way the final URL must be on the list.
  const finalUrl = res.url || res.headers.get("x-fruitbat-final-url") || "";
  if (finalUrl && finalUrl !== d.url.href) {
    const final = allowedUrl(finalUrl);
    if (!final.ok || (final.kind !== "redirect" && final.kind !== "same-origin" && final.kind !== "exact")) {
      netStats.redirect_rejected++;
      throw new NetworkPolicyError(`redirected off-list: ${final.ok ? final.kind : final.reason}`, new URL(finalUrl).origin);
    }
  }
  return res;
}

/** Hosts for the CSP `connect-src` (scripts/csp.mjs, S1-12): 'self' + Hub + recorded redirect hosts. */
export function cspConnectSrc(): string[] {
  const p = webPolicy();
  const hosts = new Set<string>(["'self'"]);
  for (const u of exactUrls()) hosts.add(new URL(u).origin);
  for (const h of p.redirect_hosts ?? []) hosts.add(`https://${h}`);
  for (const h of p.redirect_host_patterns ?? []) hosts.add(`https://${h}`);
  return [...hosts];
}

const VOICE_BASE = "/models/kokoro-voices/";
const VOICE_ID = /^[a-z]{2}_[a-z]+$/;

/** Load a Kokoro voice's style vectors from the same origin. */
export async function loadVoice(id: string): Promise<Float32Array> {
  if (!VOICE_ID.test(id)) throw new Error("bad voice id");
  const res = await guardedFetch(`${VOICE_BASE}${id}.bin`);
  if (!res.ok) throw new Error(`voice_http_${res.status}`);
  return new Float32Array(await res.arrayBuffer());
}
