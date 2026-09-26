// S1-13a (docs/PLAN.md, "test infra: serve pinned model files from a local cache in Playwright").
//
// The problem this fixes: every spec that loads the real voice (Kokoro, 92 MB, spec/models.json
// web.voice) opens a fresh browser context, so it downloads the model cold from the Hugging Face
// Hub. With `workers: 1` (playwright.config.ts) the whole `wasm-ci` suite serialized that
// download across dial/readall/loading/skeleton/smoke/intake and took 20+ minutes, timing out
// the 300 s `prewarmed` waits whenever the network was shared.
//
// This module is two things:
//
//   1. `warmModelCache()` -- a plain download function. It fills
//      `web/.cache/models/<host>/<path>` (path = the pinned file's own request URL, so the route
//      handler below can recompute the same path from an intercepted request with no lookup
//      table) with every pinned voice file, and the summarizer's files too when
//      `MODEL_CACHE_FULL=1` (for `webgpu-local` / bench runs that need the real 470 MB
//      summarizer). It is idempotent: a cached file whose size already matches spec/models.json
//      is left alone. It is the Playwright `globalSetup` (see playwright.config.ts) and is also
//      what `tests/model-cache-warm.mjs` calls directly for a CI pre-step / `actions/cache` fill,
//      decoupled from actually running the suite.
//
//   2. `test` / `expect` -- a `@playwright/test` fixture. Its `context` (and, through it, every
//      `page` the built-in `page` fixture creates from that context) routes
//      `https://huggingface.co/**` and `https://*.cdn.hf.co/**` to the cached file when one
//      exists: a direct 200 (206 for a `Range` request -- Transformers.js probes with them) with
//      the right Content-Type/Content-Length, for any file under LARGE_FILE_INLINE_LIMIT_BYTES.
//      `https://huggingface.co/**` already covers the small-file `/api/resolve-cache/**` redirect
//      form (network.json) since it shares the host; a request that lands there for an uncached
//      file simply misses the cache lookup and falls through. A cache miss on ANY pattern falls
//      through to the real network (`route.fallback()`), so a cold cache (or a file
//      `MODEL_CACHE_FULL` didn't warm) still works, just slowly.
//
//      DEVIATION from the packet spec's "200 (no redirect)": a cached file over
//      LARGE_FILE_INLINE_LIMIT_BYTES (currently only the voice model's 92 MB
//      onnx/model_quantized.onnx, and the summarizer's 469 MB .onnx_data under
//      MODEL_CACHE_FULL=1) is instead answered with a 302 to a same-origin path served by
//      tests/dev-proxy.mjs. Verified empirically while building this packet: route.fulfill()'s
//      CDP transport (base64 body over the DevTools protocol) crashes the page/context/browser
//      outright somewhere between 70 MB and 92 MB -- a 70 MB slice of the real cached file
//      fulfills fine; the full 92,361,116-byte file closes the browser instead, in both wasm-ci
//      (headless) and webgpu-local (headed), with a minimal repro outside this app entirely (see
//      dev-proxy.mjs's header comment). A same-origin redirect needs no net.ts change: `kind:
//      "same-origin"` is already unconditionally allowed by guardedFetch, so this stays inside
//      the existing security model rather than adding a new allowlisted host. In `BASE_URL` mode
//      (testing a deployed Space, no local `webServer`/proxy running) a large cached file is
//      never redirected -- there is nowhere same-origin to send it -- so it always falls through
//      to the real network there; only the small pinned files are ever cached in that mode.
//
//   `installModelCacheRoute(context)` is the same routing exposed as a function, for the two
//   specs (dial.spec.ts, readall.spec.ts) that open their page with `browser.newPage()` in a
//   `test.beforeAll` to share one page/one voice-load across every test in the file -- `browser`
//   is a worker-scoped fixture but `context`/`page` are test-scoped, so `beforeAll` cannot see
//   this file's extended `context` fixture at all. Those two specs call it once, on
//   `page.context()`, right after `browser.newPage()`. It takes a `BrowserContext`, never a
//   `Page`: the actual model download happens inside a dedicated Worker (tts.worker.ts), and only
//   context-level route interception reaches a Worker's own fetches -- a route registered on the
//   `Page` itself never fires for them, confirmed empirically while building this packet.
//
// privacy.spec.ts deliberately keeps importing the plain `@playwright/test` `test`/`expect`: it
// asserts the exact Hub URLs and redirect hosts a real run makes, so it must never see a mocked
// response. loading.spec.ts imports this fixture (it needs the voice to auto-load quickly like
// every other spec) but also registers its own `page.route("https://huggingface.co/**", ...)` to
// capture request order/timing for its own assertions; Playwright always gives a page-level route
// priority over this fixture's context-level route regardless of registration order, so
// loading.spec's real-network, request-order assertions are unaffected by caching -- its Hub
// traffic is untouched, just as its comment ("real enough to prove ordering") expects.
import { test as base, expect, type BrowserContext, type Route } from "@playwright/test";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_DIR = path.join(ROOT, "web", ".cache", "models");
const MODELS_PATH = path.join(ROOT, "spec", "models.json");

interface PinnedFile {
  path: string;
  bytes: number;
}
interface PinnedModel {
  id: string;
  revision: string;
  url_template: string;
  files: PinnedFile[];
}
interface ModelsSpec {
  web: { voice: PinnedModel; summarizer: PinnedModel };
}

function loadModels(): ModelsSpec {
  // fs + JSON.parse, not a JSON import: Playwright's own test-file loader needs an explicit
  // `type: "json"` import attribute for JSON imports (see smoke.spec.ts), and this file also
  // runs under plain `node` (tests/model-cache-warm.mjs), which has the same requirement.
  return JSON.parse(readFileSync(MODELS_PATH, "utf8")) as ModelsSpec;
}

function fileUrl(model: PinnedModel, file: PinnedFile): string {
  return model.url_template.replace("{id}", model.id).replace("{revision}", model.revision).replace("{path}", file.path);
}

/** Where a pinned file's own request URL is cached on disk: <CACHE_DIR>/<host>/<path>. */
function cachePathForUrl(url: string): string {
  const u = new URL(url);
  return path.join(CACHE_DIR, u.hostname, ...decodeURIComponent(u.pathname).split("/").filter(Boolean));
}

function contentTypeFor(filePath: string): string {
  return filePath.endsWith(".json") ? "application/json" : "application/octet-stream";
}

// ---------------------------------------------------------------------------------------------
// 1. warmModelCache() -- fills the cache. Used by globalSetup (below) and model-cache-warm.mjs.
// ---------------------------------------------------------------------------------------------

export interface WarmResult {
  downloaded: string[];
  skipped: string[];
  totalBytes: number;
}

/** Every voice file, plus the summarizer's when `full` is set (MODEL_CACHE_FULL=1). */
function targets(full: boolean): { model: PinnedModel; file: PinnedFile }[] {
  const models = loadModels();
  const out = models.web.voice.files.map((file) => ({ model: models.web.voice, file }));
  if (full) out.push(...models.web.summarizer.files.map((file) => ({ model: models.web.summarizer, file })));
  return out;
}

/**
 * Download every target file not already cached at its expected size. Follows redirects (Node's
 * global fetch does this by default -- both the small-file 307 and the LFS 302-to-CDN forms in
 * spec/network.json), verifies the downloaded byte count against spec/models.json, and writes
 * atomically (download to `<dest>.part`, then rename) so a killed download never leaves a
 * half-written file mistaken for a good cache entry.
 */
export async function warmModelCache(opts: { full?: boolean } = {}): Promise<WarmResult> {
  const full = opts.full ?? process.env.MODEL_CACHE_FULL === "1";
  const downloaded: string[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  await Promise.all(
    targets(full).map(async ({ model, file }) => {
      const url = fileUrl(model, file);
      const dest = cachePathForUrl(url);
      if (existsSync(dest) && statSync(dest).size === file.bytes) {
        skipped.push(url);
        totalBytes += file.bytes;
        return;
      }
      await downloadTo(url, dest, file.bytes);
      downloaded.push(url);
      totalBytes += file.bytes;
    }),
  );
  return { downloaded, skipped, totalBytes };
}

async function downloadTo(url: string, dest: string, expectedBytes: number): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`model-cache: GET ${url} -> ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>), createWriteStream(tmp));
  const actual = statSync(tmp).size;
  if (actual !== expectedBytes) {
    rmSync(tmp, { force: true });
    throw new Error(`model-cache: ${url} downloaded ${actual} bytes, spec/models.json says ${expectedBytes} bytes (partial file deleted)`);
  }
  renameSync(tmp, dest);
}

// ---------------------------------------------------------------------------------------------
// 2. The Playwright fixture -- routes Hub requests to the cache.
// ---------------------------------------------------------------------------------------------

const HF_PATTERN = "https://huggingface.co/**";
const CDN_PATTERN = "https://*.cdn.hf.co/**";

// See the header comment's "DEVIATION" paragraph. 50 MB sits comfortably under the empirically
// confirmed 70 MB-safe / 92 MB-crashes boundary, leaving margin for a different Chromium build.
const LARGE_FILE_INLINE_LIMIT_BYTES = 50 * 1024 * 1024;
const SEED_PREFIX = "/__model_cache__/";

/** The app's own same-origin base URL, or null when there is no local proxy to redirect to
 *  (BASE_URL mode: testing a deployed Space). Mirrors playwright.config.ts's own baseURL logic. */
function sameOriginBase(): string | null {
  if (process.env.BASE_URL) return null;
  return `http://localhost:${process.env.PW_PORT ?? "4173"}`;
}

/** dest's path relative to CACHE_DIR, as URL path segments (POSIX separators, percent-encoded). */
function cacheRelativePath(dest: string): string {
  return encodeURI(path.relative(CACHE_DIR, dest).split(path.sep).join("/"));
}

function parseRange(header: string, total: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === "" && m[2] !== "") {
    const suffixLength = parseInt(m[2], 10);
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = m[1] === "" ? 0 : parseInt(m[1], 10);
    end = m[2] === "" ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || start >= total) return null;
  return { start, end };
}

function readRange(filePath: string, start: number, end: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    createReadStream(filePath, { start, end })
      .on("data", (c) => chunks.push(c as Buffer))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
}

async function handleRoute(route: Route): Promise<void> {
  const request = route.request();
  const dest = cachePathForUrl(request.url());
  if (!existsSync(dest)) {
    await route.fallback();
    return;
  }
  const total = statSync(dest).size;
  if (total > LARGE_FILE_INLINE_LIMIT_BYTES) {
    const base = sameOriginBase();
    if (!base) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 302,
      headers: { location: `${base}${SEED_PREFIX}${cacheRelativePath(dest)}`, "access-control-allow-origin": "*" },
    });
    return;
  }
  const contentType = contentTypeFor(dest);
  const range = request.headers()["range"];
  if (range) {
    const parsed = parseRange(range, total);
    if (!parsed) {
      await route.fulfill({ status: 416, headers: { "content-range": `bytes */${total}` } });
      return;
    }
    const body = await readRange(dest, parsed.start, parsed.end);
    await route.fulfill({
      status: 206,
      headers: {
        "content-type": contentType,
        "content-length": String(body.length),
        "content-range": `bytes ${parsed.start}-${parsed.end}/${total}`,
        "accept-ranges": "bytes",
      },
      body,
    });
    return;
  }
  const body = await readFile(dest);
  await route.fulfill({
    status: 200,
    headers: { "content-type": contentType, "content-length": String(total), "accept-ranges": "bytes" },
    body,
  });
}

/**
 * Route a context's Hub traffic to the cache. Takes a `BrowserContext`, never a `Page`: the voice
 * model download happens inside a dedicated Worker (tts.worker.ts), and only context-level route
 * interception reaches a Worker's own fetches -- `page.route()` does not (confirmed empirically:
 * a page-level route on a Worker-fetched URL never fires, hit or miss). See dial.spec.ts /
 * readall.spec.ts, which call this with `page.context()` from a `browser.newPage()`-created page.
 */
export async function installModelCacheRoute(context: BrowserContext): Promise<void> {
  await context.route(HF_PATTERN, handleRoute);
  await context.route(CDN_PATTERN, handleRoute);
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await installModelCacheRoute(context);
    await use(context);
  },
});
export { expect };

// ---------------------------------------------------------------------------------------------
// Playwright globalSetup (playwright.config.ts: `globalSetup: "./tests/model-cache.ts"`).
// ---------------------------------------------------------------------------------------------
export default async function globalSetup(): Promise<void> {
  const full = process.env.MODEL_CACHE_FULL === "1";
  const t0 = Date.now();
  const result = await warmModelCache({ full });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(
    `model-cache: warmed ${result.downloaded.length} file(s), ${result.skipped.length} already cached, ${Math.round(result.totalBytes / 1e6)} MB total, ${seconds}s${full ? " (MODEL_CACHE_FULL=1: voice + summarizer)" : " (voice only; set MODEL_CACHE_FULL=1 for the summarizer too)"}`,
  );
}
