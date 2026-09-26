#!/usr/bin/env node
// S1-13a: fills web/.cache/models/ without running the Playwright suite, so CI can warm the
// cache as its own step (before `actions/cache` would even have a hit to restore, and cheaply
// re-runnable if the cache action misses) and so a human can pre-warm before `npm run test:e2e`.
// `npm run test:e2e` warms the same cache itself via `globalSetup` (tests/model-cache.ts); running
// this first just means that globalSetup call is a no-op (every file already at its pinned size).
//
// MODEL_CACHE_FULL=1 also warms the summarizer's files (470 MB) for a webgpu-local / bench run.
import { warmModelCache } from "./model-cache.ts";

const full = process.env.MODEL_CACHE_FULL === "1";
const t0 = Date.now();
const result = await warmModelCache({ full });
const seconds = ((Date.now() - t0) / 1000).toFixed(1);
console.log(
  `model-cache-warm: ${result.downloaded.length} downloaded, ${result.skipped.length} already cached, ` +
    `${Math.round(result.totalBytes / 1e6)} MB total, ${seconds}s` +
    (full ? " (MODEL_CACHE_FULL=1: voice + summarizer)" : " (voice only; set MODEL_CACHE_FULL=1 for the summarizer too)"),
);
if (result.downloaded.length) {
  console.log("model-cache-warm: downloaded -> " + result.downloaded.join(", "));
}
