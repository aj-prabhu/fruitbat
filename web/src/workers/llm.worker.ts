/// <reference lib="webworker" />
// The summarizer worker (docs/PLAN.md S1-05). Owns the pinned model; the main thread
// (engine/llm.ts) owns chunking, parsing, grounding and the UI. Every message carries a runId.
// Stage-two probe = one real generated token after the download. Memory failure on load →
// one retry with the low-end tier (spec/models.json). Fault injection via the `inject` field.
import {
  AutoModelForCausalLM,
  AutoTokenizer,
  InterruptableStoppingCriteria,
  TextStreamer,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import { configureRuntime, load, type LoadProgress } from "../engine/loader";
import { summarizerTiers, type PinnedModel } from "../engine/pins";
import type { Inject } from "../engine/capabilities";
import type { MainToWorker, WorkerToMain } from "../engine/llmProtocol";

configureRuntime();
const post = (m: WorkerToMain) => self.postMessage(m);

let tokenizer: PreTrainedTokenizer | null = null;
let model: PreTrainedModel | null = null;
let loadedRole = "";
let inject: Inject = null;
let oomFired = false;
let stopper: InterruptableStoppingCriteria | null = null;
let generating: number | null = null; // runId of the generation in flight
let probing: number | null = null; // runId of the 1-token probe in flight
let loadingRun: number | null = null; // runId of the model load in flight
const aborted = new Set<number>();

function isMemoryError(e: unknown): boolean {
  const s = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /out of memory|outofmemory|allocation|alloc failed|memory/i.test(s);
}

let loadAbort: AbortController | null = null;

async function loadTier(spec: PinnedModel & { role: string }, runId: number): Promise<void> {
  loadAbort = new AbortController();
  const signal = loadAbort.signal;
  if (inject === "oom" && spec.role !== "low-end" && !oomFired) {
    oomFired = true;
    const e = new Error("simulated allocation failure (inject=oom)");
    e.name = "OutOfMemory";
    throw e;
  }
  const progress = (p: LoadProgress) => {
    const q = p as { status: string; file?: string; loaded?: number; total?: number };
    post({ type: "progress", runId, status: q.status, file: q.file, loaded: q.loaded, total: q.total });
  };
  tokenizer = await load(spec, (id, o) => AutoTokenizer.from_pretrained(id, { revision: o.revision, progress_callback: o.progress_callback }), progress, signal);
  model = await load(
    spec,
    (id, o) =>
      AutoModelForCausalLM.from_pretrained(id, {
        dtype: o.dtype as "q4f16",
        device: o.device as "webgpu",
        revision: o.revision,
        progress_callback: o.progress_callback,
      }),
    progress,
    signal,
  );
  loadedRole = spec.role;
}

async function onLoad(msg: Extract<MainToWorker, { type: "load" }>): Promise<void> {
  inject = msg.inject;
  const t0 = performance.now();
  loadingRun = msg.runId;
  try {
    await onLoadInner(msg, t0);
  } finally {
    loadingRun = null;
    // A Stop during the load is confirmed only once the factories have returned (Codex review, PR #16).
    if (aborted.has(msg.runId)) post({ type: "aborted", runId: msg.runId });
  }
}

async function onLoadInner(msg: Extract<MainToWorker, { type: "load" }>, t0: number): Promise<void> {
  try {
    await loadTier(msg.model, msg.runId);
    if (aborted.has(msg.runId)) return;
    post({ type: "loaded", runId: msg.runId, modelId: msg.model.id, role: loadedRole, downgraded: false, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    if (aborted.has(msg.runId) || (e instanceof Error && e.name === "AbortError")) {
      // Stop during the download: in-flight requests cancelled by the loader's signal (Codex review, PR #16).
      // onLoad's finally posts "aborted" for a Stop; a bare AbortError without one is posted here.
      if (!aborted.has(msg.runId)) post({ type: "aborted", runId: msg.runId });
      return;
    }
    if (!isMemoryError(e)) {
      post({ type: "error", runId: msg.runId, name: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    const low = summarizerTiers().find((t) => t.role === "low-end");
    if (!low || msg.model.role === "low-end") {
      post({ type: "error", runId: msg.runId, name: "OutOfMemory", message: "memory failure and no smaller tier" });
      return;
    }
    try {
      tokenizer = null;
      model = null;
      await loadTier(low, msg.runId);
      if (aborted.has(msg.runId)) return;
      post({ type: "loaded", runId: msg.runId, modelId: low.id, role: low.role, downgraded: true, ms: Math.round(performance.now() - t0) });
    } catch (e2) {
      if (aborted.has(msg.runId)) return;
      post({ type: "error", runId: msg.runId, name: e2 instanceof Error ? e2.name : "Error", message: e2 instanceof Error ? e2.message : String(e2) });
    }
  }
}

async function onProbe(msg: Extract<MainToWorker, { type: "probe" }>): Promise<void> {
  const t0 = performance.now();
  probing = msg.runId;
  try {
    if (!tokenizer || !model) throw new Error("not loaded");
    if (inject === "devicelost") {
      const e = new Error("simulated GPU device lost (inject=devicelost)");
      e.name = "DeviceLost";
      throw e;
    }
    const inputs = tokenizer("Hi") as Record<string, unknown>;
    const out = (await model.generate({ ...inputs, max_new_tokens: 1, do_sample: false })) as { dims: number[] };
    const ok = Array.isArray(out.dims) && out.dims.length === 2 && out.dims[1] >= 1;
    post({ type: "probe_result", runId: msg.runId, ok, error: ok ? undefined : "no token", ms: Math.round(performance.now() - t0) });
  } catch (e) {
    post({ type: "probe_result", runId: msg.runId, ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), ms: Math.round(performance.now() - t0) });
  } finally {
    probing = null;
    // A Stop during the probe is confirmed only once the GPU is actually free.
    if (aborted.has(msg.runId)) post({ type: "aborted", runId: msg.runId });
  }
}

async function onGenerate(msg: Extract<MainToWorker, { type: "generate" }>): Promise<void> {
  if (!tokenizer || !model) {
    post({ type: "error", runId: msg.runId, name: "NotLoaded", message: "summarizer not loaded" });
    return;
  }
  if (aborted.has(msg.runId)) {
    post({ type: "aborted", runId: msg.runId });
    return;
  }
  const messages = msg.system ? [{ role: "system", content: msg.system }, { role: "user", content: msg.user }] : [{ role: "user", content: msg.user }];
  const inputs = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    return_dict: true,
    enable_thinking: false,
  } as Parameters<PreTrainedTokenizer["apply_chat_template"]>[1]) as Record<string, unknown> & { input_ids: { dims: number[] } };
  const promptTokens = inputs.input_ids.dims[1];
  stopper = new InterruptableStoppingCriteria();
  generating = msg.runId;
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => {
      if (aborted.has(msg.runId)) return;
      post({ type: "token", runId: msg.runId, chunkIndex: msg.chunkIndex, text });
    },
  });
  const t0 = performance.now();
  try {
    const out = (await model.generate({
      ...inputs,
      max_new_tokens: msg.maxNewTokens,
      do_sample: false,
      streamer,
      stopping_criteria: stopper,
    })) as { dims: number[] };
    if (aborted.has(msg.runId)) {
      post({ type: "aborted", runId: msg.runId });
      return;
    }
    post({ type: "chunk_done", runId: msg.runId, chunkIndex: msg.chunkIndex, tokens: Math.max(0, out.dims[1] - promptTokens), ms: Math.round(performance.now() - t0) });
  } catch (e) {
    if (aborted.has(msg.runId)) {
      post({ type: "aborted", runId: msg.runId });
      return;
    }
    post({ type: "error", runId: msg.runId, name: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) });
  } finally {
    generating = null;
    stopper = null;
  }
}

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case "load":
      void onLoad(msg);
      break;
    case "probe":
      void onProbe(msg);
      break;
    case "generate":
      void onGenerate(msg);
      break;
    case "abort":
      aborted.add(msg.runId);
      loadAbort?.abort();
      if (generating === msg.runId && stopper) stopper.interrupt();
      else if (probing !== msg.runId && loadingRun !== msg.runId) post({ type: "aborted", runId: msg.runId }); // else onProbe/onLoad confirm when done
      break;
  }
};
