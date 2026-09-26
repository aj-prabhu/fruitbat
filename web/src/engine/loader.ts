// The one model loader (docs/PLAN.md S1-03a). S1-04 (voice) and S1-05 (summarizer) call this;
// nothing else touches Transformers.js's env. It pins the revision, routes every Transformers.js
// fetch through net.ts (rule 1), uses the browser Cache API so a second load is a cache hit
// (rule 11), and turns an AbortSignal into a rejected load with in-flight downloads cancelled.
import { env, type ProgressInfo } from "@huggingface/transformers";
import { guardedFetch } from "./net";
import { pinnedModels, summarizerTiers, type PinnedModel } from "./pins";

/** Transformers.js's own progress events (initiate, download, progress, progress_total, done, ready). */
export type LoadProgress = ProgressInfo;
export type OnProgress = (p: LoadProgress) => void;

const activeSignals = new Set<AbortSignal>();
let configured = false;

/** Idempotent. Sets the Transformers.js env once: pinned template, caches, guarded fetch, same-origin ORT. */
export function configureRuntime(): void {
  if (configured) return;
  configured = true;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = "https://huggingface.co/";
  env.remotePathTemplate = "{model}/resolve/{revision}/";
  const isNode = typeof process !== "undefined" && !!process.versions?.node;
  if (isNode) {
    env.useBrowserCache = false;
    env.useFSCache = true;
    env.cacheDir = process.env.FRUITBAT_HF_CACHE ?? ".cache/hf";
  } else {
    env.useBrowserCache = true; // Cache API, key env.cacheKey; second load = no network
    if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = "/ort/";
  }
  // Every Transformers.js request (model files, config, tokenizer) goes through the allowlist.
  // Transformers.js 4.3.0 probes `tokenizer_config.json` at `resolve/main/` without the revision
  // (get_tokenizer_files() passes empty options). pinUrl() rewrites that probe to the pinned
  // revision, so no unpinned URL ever leaves the page; net.ts still rejects any that would.
  env.fetch = (input: string | URL, init?: RequestInit) => {
    const signals = [...activeSignals];
    const merged: RequestInit = { ...init };
    if (signals.length) merged.signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    return guardedFetch(pinUrl(input), merged);
  };
}

/** Options forwarded to a Transformers.js `from_pretrained` call. */
export interface PretrainedOptions {
  revision: string;
  dtype?: string;
  device?: string;
  progress_callback?: (p: LoadProgress) => void;
}

/** Factories still running, including ones whose load() already rejected on abort. */
const inflight = new Set<Promise<unknown>>();

/**
 * Resolves once every factory started by load() has settled. A cancelled load() rejects at
 * once so Stop feels instant, but its download or session init may still be winding down;
 * callers that must not overlap it (the LLM worker's Stop confirmation) wait here.
 */
export function loadsSettled(): Promise<void> {
  return Promise.allSettled([...inflight]).then(() => undefined);
}

/**
 * Load a pinned model through a Transformers.js factory.
 * - `factory` receives the pinned id and options (revision, dtype, device, progress callback).
 * - `onProgress` sees the same events Transformers.js emits (file, loaded, total).
 * - `signal` aborts: in-flight downloads are cancelled and the returned promise rejects with
 *   an `AbortError`. Files already fully cached are kept, so the next call resumes from them.
 * Note: `AbortSignal.any` over all active loads means aborting one load also cancels other
 * loads' in-flight requests; they resume from cache on retry. Loads are sequential in practice.
 */
export async function load<T>(
  spec: PinnedModel,
  factory: (id: string, options: PretrainedOptions) => Promise<T>,
  onProgress?: OnProgress,
  signal?: AbortSignal,
): Promise<T> {
  configureRuntime();
  if (signal?.aborted) throw abortError();
  if (signal) activeSignals.add(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const work = factory(spec.id, {
    revision: spec.revision,
    dtype: spec.dtype,
    device: spec.device,
    progress_callback: (p: LoadProgress) => onProgress?.(p),
  });
  // The signal stays bound until the factory itself settles, not just until the race does:
  // a cancelled load may still be in a cache lookup or session init whose later fetches must
  // also carry the abort (Codex review, PR #4).
  const cleanup = () => {
    if (signal) {
      activeSignals.delete(signal);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
  void work.then(cleanup, cleanup);
  // Tracked until the factory settles and, when its result lands after the load was cancelled,
  // until that ownerless result's sessions are freed; loadsSettled() waits on both (Codex review, PR #16).
  const tracked: Promise<unknown> = work
    .then(async (v) => {
      if (signal?.aborted) await (v as { dispose?: () => unknown } | null)?.dispose?.();
    })
    .catch(() => undefined)
    .finally(() => inflight.delete(tracked));
  inflight.add(tracked);
  if (!signal) return work;
  return Promise.race([work, aborted]);
}

/** Rewrite a Hub URL at `resolve/main/` for a pinned model id to its pinned revision. */
export function pinUrl(input: string | URL): string {
  const s = typeof input === "string" ? input : input.href;
  const m = /^(https:\/\/huggingface\.co\/)(.+?)\/resolve\/main\/(.+)$/.exec(s);
  if (!m) return s;
  const { voice } = pinnedModels().web;
  const rev = [...summarizerTiers(), voice].find((p) => p.id === m[2])?.revision; // fallback tiers too (S1-05)
  return rev ? `${m[1]}${m[2]}/resolve/${rev}/${m[3]}` : s;
}

function abortError(): Error {
  const e = new Error("load aborted");
  e.name = "AbortError";
  return e;
}
