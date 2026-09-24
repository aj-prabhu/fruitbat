// S1-00a walking skeleton: textarea -> Summarize -> bullets -> spoken. No UI, no styling.
// Proves the pinned runtime (Transformers.js 4.x + vendored Kokoro loader) generates real text
// and real audio in the browser with pinned model revisions. Everything after this packet
// replaces this file; nothing here is product code.
import { AutoTokenizer, AutoModelForCausalLM, TextStreamer } from "@huggingface/transformers";
import type { PreTrainedModel, PreTrainedTokenizer } from "@huggingface/transformers";
import { KokoroTTS } from "./vendor/kokoro/kokoro.js";
import { loadVoice } from "./engine/net";
import { configureRuntime, load, type LoadProgress } from "./engine/loader";
import { pinnedModels } from "./engine/pins";

// S1-03a: the runtime (pinned template, caches, guarded fetch, same-origin ORT) is configured by
// the loader; the model pins come from spec/models.json.
configureRuntime();
const PINS = { llm: pinnedModels().web.summarizer, tts: { ...pinnedModels().web.voice, voice: "af_heart" as const } };

type Phase = "starting" | "idle" | "loading" | "generating" | "done" | "failed";

const S = {
  state: "starting" as Phase,
  isolated: typeof crossOriginIsolated !== "undefined" && crossOriginIsolated,
  gpu: { available: false, adapter: false, device: false, f16: false },
  bullets: [] as string[],
  raw: "",
  error: null as string | null,
  audioScheduled: 0,
  ctxState: "none",
  play: "idle" as "idle" | "playing" | "done",
  playStart: null as number | null,
  timings: {} as Record<string, number>,
  downloaded: {} as Record<string, number>,
  ttsMaxTokens: 0,
  played(): number {
    if (S.playStart === null || !ctx) return 0;
    return Math.max(0, Math.min(ctx.currentTime - S.playStart, S.audioScheduled));
  },
};
(window as unknown as { __skeleton: typeof S }).__skeleton = S;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLParagraphElement>("status");
const textEl = $<HTMLTextAreaElement>("text");
const goEl = $<HTMLButtonElement>("go");
const stopEl = $<HTMLButtonElement>("stop");
const bulletsEl = $<HTMLUListElement>("bullets");
const rawEl = $<HTMLPreElement>("raw");

function setStatus(s: string) {
  statusEl.textContent = s;
}
function mark(name: string) {
  S.timings[name] = Math.round(performance.now());
}

let ctx: AudioContext | null = null;
let llm: { tokenizer: PreTrainedTokenizer; model: PreTrainedModel } | null = null;
let tts: KokoroTTS | null = null;
let nextStart = 0;
let speakChain: Promise<void> = Promise.resolve();
let speechFailed = false;
const sources: AudioBufferSourceNode[] = [];
let runId = 0;

async function probe() {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  S.gpu.available = !!gpu;
  if (!gpu) return;
  try {
    const adapter = await gpu.requestAdapter();
    S.gpu.adapter = !!adapter;
    if (!adapter) return;
    S.gpu.f16 = adapter.features.has("shader-f16");
    const device = await adapter.requestDevice();
    S.gpu.device = !!device;
    device.destroy();
  } catch {
    // probe failure is a result, not an error
  }
}

function progress(info: LoadProgress) {
  if (info.status === "progress" && info.file && typeof info.loaded === "number") {
    S.downloaded[info.file] = info.loaded;
    const mb = Object.values(S.downloaded).reduce((a, b) => a + b, 0) / 1e6;
    setStatus(`loading models: ${mb.toFixed(0)} MB so far (${info.file})`);
  }
}

async function loadAll() {
  S.state = "loading";
  mark("load_start");
  const [tokenizer, model] = await Promise.all([
    load(PINS.llm, (id, o) => AutoTokenizer.from_pretrained(id, { revision: o.revision, progress_callback: o.progress_callback }), progress),
    load(
      PINS.llm,
      (id, o) =>
        AutoModelForCausalLM.from_pretrained(id, {
          dtype: o.dtype as "q4f16",
          device: o.device as "webgpu",
          revision: o.revision,
          progress_callback: o.progress_callback,
        }),
      progress,
    ),
  ]);
  llm = { tokenizer, model };
  mark("llm_loaded");
  tts = await load(
    PINS.tts,
    (id, o) =>
      KokoroTTS.from_pretrained(id, {
        dtype: o.dtype as "q8",
        device: o.device as "wasm",
        revision: o.revision,
        progress_callback: o.progress_callback,
        loadVoice,
      }),
    progress,
  );
  S.ttsMaxTokens = tts.max_tokens;
  mark("tts_loaded");
}

function speak(text: string, id: number) {
  speakChain = speakChain.then(async () => {
    if (id !== runId || !tts || !ctx) return;
    const audio = await tts.generate(text, { voice: PINS.tts.voice });
    if (id !== runId) return;
    const buf = ctx.createBuffer(1, audio.audio.length, audio.sampling_rate);
    buf.copyToChannel(Float32Array.from(audio.audio as ArrayLike<number>), 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const t = Math.max(ctx.currentTime, nextStart);
    src.start(t);
    sources.push(src);
    S.play = "playing";
    src.onended = () => {
      const i = sources.indexOf(src);
      if (i >= 0) sources.splice(i, 1);
      if (sources.length === 0 && ctx && ctx.currentTime >= nextStart - 0.05) S.play = "done";
    };
    if (S.playStart === null) {
      S.playStart = t;
      mark("first_audio_scheduled");
    }
    nextStart = t + buf.duration;
    S.audioScheduled += buf.duration;
    S.ctxState = ctx.state;
  }).catch((e: unknown) => {
    // Keep the chain usable after a failed synthesis (Codex review, PR #2), but record it so the
    // run reports failure, not success (Codex review, PR #3).
    if (id === runId) {
      S.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      speechFailed = true;
    }
  });
}

function pushBullet(text: string, id: number) {
  if (id !== runId) return;
  S.bullets.push(text);
  const li = document.createElement("li");
  li.textContent = text;
  bulletsEl.appendChild(li);
  if (S.bullets.length === 1) mark("first_bullet");
  speak(text, id);
}

const PROMPT =
  "Summarize the text below in 3 to 6 bullet points. Each bullet is one plain sentence and starts with \"- \". Keep every number and name exactly as written. Output only the bullets.";

async function summarize(text: string, id: number) {
  if (!llm) throw new Error("llm_not_loaded");
  S.state = "generating";
  mark("gen_start");
  const messages = [{ role: "user", content: `${PROMPT}\n\n${text}` }];
  const inputs = llm.tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    return_dict: true,
    enable_thinking: false,
  } as Parameters<PreTrainedTokenizer["apply_chat_template"]>[1]) as Record<string, unknown>;
  let buf = "";
  const flushLine = (line: string) => {
    const m = line.match(/^\s*[-•*]\s+(.+?)\s*$/);
    if (m) pushBullet(m[1], id);
  };
  const streamer = new TextStreamer(llm.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (t: string) => {
      if (id !== runId) return;
      if (S.raw.length === 0) mark("first_token");
      S.raw += t;
      rawEl.textContent = S.raw;
      buf += t;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        flushLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
  });
  await llm.model.generate({ ...inputs, max_new_tokens: 220, do_sample: false, streamer });
  if (id !== runId) return; // stopped mid-generation: drop the tail
  if (buf.trim()) flushLine(buf);
  mark("gen_done");
}

let inFlight: Promise<void> | null = null;

goEl.addEventListener("click", async () => {
  if (S.state === "loading" || S.state === "generating") return; // one run at a time (Codex review, PR #3)
  const id = ++runId;
  stopScheduledAudio(); // a new summary never plays over the previous one (Codex review, PR #4)
  if (inFlight) await inFlight.catch(() => undefined); // a stopped run must finish before its replacement starts
  if (id !== runId) return;
  S.bullets = [];
  S.raw = "";
  S.error = null;
  S.audioScheduled = 0;
  S.playStart = null;
  S.play = "idle";
  speechFailed = false;
  bulletsEl.replaceChildren();
  rawEl.textContent = "";
  mark("click");
  const run = (async () => {
    if (!ctx) ctx = new AudioContext({ sampleRate: 24000 });
    await ctx.resume();
    S.ctxState = ctx.state;
    if (!llm || !tts) await loadAll();
    if (id !== runId) return; // stopped during loading: do not continue into generation (Codex review, PR #6)
    const text = textEl.value.trim();
    if (!text) throw new Error("empty_input");
    setStatus("summarizing");
    await summarize(text, id);
    if (id !== runId) return;
    await speakChain;
    if (speechFailed) throw new Error(`speech_failed: ${S.error ?? "unknown"}`);
    S.ctxState = ctx.state;
    S.state = "done"; // generation and synthesis done; playback is tracked by S.play (Codex review, PR #4)
    setStatus(`done: ${S.bullets.length} bullets, ${S.audioScheduled.toFixed(1)} s of audio`);
  })();
  inFlight = run;
  try {
    await run;
  } catch (e) {
    if (id !== runId) return; // stopped: the replacement run reports its own state
    S.state = "failed";
    S.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    setStatus(`failed: ${S.error}`);
  } finally {
    if (inFlight === run) inFlight = null;
  }
});

function stopScheduledAudio() {
  for (const src of sources.splice(0)) {
    try {
      src.stop();
    } catch {
      // already ended
    }
  }
  nextStart = 0;
}

stopEl.addEventListener("click", () => {
  runId++;
  stopScheduledAudio();
  if (ctx) void ctx.suspend();
  S.state = "idle";
  setStatus("stopped");
});

void probe().then(() => {
  S.state = "idle";
  setStatus(
    `ready. crossOriginIsolated=${S.isolated} webgpu=${S.gpu.device ? "yes" : "no"} shader-f16=${S.gpu.f16 ? "yes" : "no"}`,
  );
});
