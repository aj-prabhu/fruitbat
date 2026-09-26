// The TTS worker (docs/PLAN.md S1-04). Owns the Kokoro model and the phonemizer so synthesis
// never touches the main thread. Rule 2: before EVERY synthesis call the phoneme string is
// checked against the model's limit (`assertFits`); the vendored loader also refuses to
// truncate (`tts_overlimit`). Rule 1: model files load through engine/loader.ts (pinned revision,
// guarded fetch); the voice files come from net.ts's loadVoice (same origin).
//
// Protocol (main -> worker): load | plan | synth | speak | cancel. (worker -> main): loaded |
// progress | planned | pcm | overlimit | error. Every message carries the runId it belongs to;
// the main thread drops anything stale (engine/audioQueue.ts).
import { env } from "@huggingface/transformers";
import { configureRuntime, load, type LoadProgress } from "../engine/loader";
import { loadVoice } from "../engine/net";
import { pinnedModels } from "../engine/pins";
import { KokoroTTS, phonemize } from "../vendor/kokoro/kokoro.js";
import { segmentSentences } from "../core/segment";
import { splitTtsSafe, splitByMeasure, assertFits, TtsOverlimitError, type Limits } from "../core/split";

export interface PlannedSegment {
  seq: number;
  text: string;
  start: number;
  end: number;
  phonemes: string;
}

export type ToWorker =
  | { type: "load" }
  | { type: "plan"; runId: number; text: string; limits: Limits; firstPieceTarget?: number }
  | { type: "synth"; runId: number; seq: number; phonemes: string; start: number; end: number; voice: string; speed: number; limit: number }
  | { type: "speak"; runId: number; seq: number; text: string; voice: string; speed: number; limits: Limits }
  | { type: "cancel"; runId: number };

export type FromWorker =
  | { type: "loaded"; maxTokens: number; downloadedBytes: number; isolated: boolean; threads: number | null; cores: number; warmupMs: number }
  | { type: "progress"; file: string; loaded: number; total: number }
  | { type: "planned"; runId: number; segments: PlannedSegment[]; maxPhonemes: number; splitMs: number }
  | { type: "pcm"; runId: number; seq: number; start: number; end: number; sampleRate: number; pcm: Float32Array; phonemes: number; synthMs: number }
  | { type: "overlimit"; runId: number; seq: number; phonemes: number; limit: number }
  | { type: "error"; runId: number; seq: number; name: string; message: string };

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let tts: KokoroTTS | null = null;
let loading: Promise<KokoroTTS> | null = null;
let downloadedBytes = 0;
let warmedUp = false;
const cancelled = new Set<number>();
const LANGUAGE = "a"; // en-us voices (af_*)
const FIRST_PIECE_TARGET = 80; // phonemes: about 4 s of speech, so first audio comes fast

function post(msg: FromWorker, transfer?: Transferable[]): void {
  scope.postMessage(msg, transfer);
}

function ensureLoaded(): Promise<KokoroTTS> {
  if (tts) return Promise.resolve(tts);
  if (!loading) {
    configureRuntime();
    // ORT defaults to 4 WASM threads; Kokoro q8 is compute-bound and real-time only just at 4.
    // Use more of the cores when the page is cross-origin isolated (threads need it).
    const wasm = env.backends.onnx.wasm as { numThreads?: number } | undefined;
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4;
    if (wasm && typeof crossOriginIsolated !== "undefined" && crossOriginIsolated) {
      wasm.numThreads = Math.max(4, Math.min(8, cores - 2));
    }
    const spec = pinnedModels().web.voice;
    const seen = new Map<string, number>();
    loading = load(
      spec,
      (id, o) =>
        KokoroTTS.from_pretrained(id, {
          dtype: o.dtype as "q8",
          device: o.device as "wasm",
          revision: o.revision,
          progress_callback: o.progress_callback,
          loadVoice,
        }),
      (p: LoadProgress) => {
        if (p.status === "progress" && "file" in p) {
          const prev = seen.get(p.file) ?? 0;
          if (p.loaded > prev) {
            downloadedBytes += p.loaded - prev;
            seen.set(p.file, p.loaded);
          }
          post({ type: "progress", file: p.file, loaded: p.loaded, total: p.total });
        }
      },
    ).then((m) => {
      tts = m;
      return m;
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

type Synth = { pcm: Float32Array; sampleRate: number; synthMs: number };
let inferChain: Promise<unknown> = Promise.resolve();

/**
 * Kokoro runs one inference at a time. Requests queue here rather than inside Transformers.js,
 * so a request whose run was cancelled is dropped before it starts (null), and synthMs counts
 * only its own inference, not the wait behind other requests (Codex review, PR #17).
 */
function synthesizePhonemes(model: KokoroTTS, phonemes: string, voice: string, speed: number, limit: number, runId?: number): Promise<Synth | null> {
  const run = () => (runId !== undefined && cancelled.has(runId) ? Promise.resolve(null) : synthesizeNow(model, phonemes, voice, speed, limit));
  const p = inferChain.then(run, run);
  inferChain = p.catch(() => undefined);
  return p;
}

async function synthesizeNow(model: KokoroTTS, phonemes: string, voice: string, speed: number, limit: number): Promise<Synth> {
  assertFits(phonemes.length, limit);
  const t0 = performance.now();
  const audio = await model.generate_from_phonemes(phonemes, { voice, speed });
  const synthMs = performance.now() - t0;
  const raw = audio.audio as unknown;
  const pcm = raw instanceof Float32Array ? raw : Array.isArray(raw) ? (raw[0] as Float32Array) : Float32Array.from(raw as ArrayLike<number>);
  return { pcm, sampleRate: audio.sampling_rate, synthMs };
}

scope.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      const model = await ensureLoaded();
      // Warm-up: the first inference pays for session initialization (about 10 s on WASM), so it
      // is paid here, inside load(), not on the user's first "Read all" (warm TTFA gate, 3 s).
      const t0 = performance.now();
      if (!warmedUp) {
        await synthesizePhonemes(model, await phonemize("Ready.", LANGUAGE), "af_heart", 1, 510);
        warmedUp = true;
      }
      const wasm = env.backends.onnx.wasm as { numThreads?: number } | undefined;
      post({
        type: "loaded",
        maxTokens: model.max_tokens,
        downloadedBytes,
        isolated: typeof crossOriginIsolated !== "undefined" && crossOriginIsolated,
        threads: wasm?.numThreads ?? null,
        cores: typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0,
        warmupMs: Math.round(performance.now() - t0),
      });
      return;
    }
    if (m.type === "cancel") {
      cancelled.add(m.runId);
      return;
    }
    if (m.type === "plan") {
      const t0 = performance.now();
      const sentences = segmentSentences(m.text);
      // Memoized: the TTS-safe split measures each candidate by phonemizing it, and the same
      // text is phonemized again for the returned pieces; one G2P pass per distinct string.
      const memo = new Map<string, Promise<string>>();
      const ph = (t: string) => {
        let p = memo.get(t);
        if (!p) {
          p = phonemize(t, LANGUAGE);
          memo.set(t, p);
        }
        return p;
      };
      let pieces = await splitTtsSafe(sentences, ph, m.limits);
      // Time to first audio: the first piece is cut small (FIRST_PIECE_TARGET phonemes) so the
      // voice starts within a few seconds instead of after a full 300-phoneme synthesis.
      const firstTarget = m.firstPieceTarget ?? FIRST_PIECE_TARGET; // 0 disables (measurements)
      if (pieces.length > 0 && firstTarget > 0 && m.limits.target > firstTarget) {
        // Ramp: first piece small (fast first audio), second piece medium, then the full target,
        // so the playback buffer has time to build while synthesis runs near real time.
        const measurePh = async (t: string) => (await ph(t)).length;
        const head: typeof pieces = [];
        await splitByMeasure(pieces[0], measurePh, firstTarget, m.limits.limit, head);
        const rest = pieces.slice(1);
        const second: typeof pieces = [];
        if (rest.length > 0) await splitByMeasure(rest[0], measurePh, firstTarget * 2, m.limits.limit, second);
        pieces = [...head, ...second, ...rest.slice(1)];
      }
      const segments: PlannedSegment[] = [];
      let maxPhonemes = 0;
      for (let i = 0; i < pieces.length; i++) {
        const phs = await ph(pieces[i].text);
        if (phs.length > maxPhonemes) maxPhonemes = phs.length;
        segments.push({ seq: i, text: pieces[i].text, start: pieces[i].start, end: pieces[i].end, phonemes: phs });
      }
      if (cancelled.has(m.runId)) return;
      post({ type: "planned", runId: m.runId, segments, maxPhonemes, splitMs: performance.now() - t0 });
      return;
    }
    if (m.type === "synth") {
      const model = await ensureLoaded();
      if (cancelled.has(m.runId)) return;
      const r = await synthesizePhonemes(model, m.phonemes, m.voice, m.speed, m.limit, m.runId);
      if (!r || cancelled.has(m.runId)) return;
      const { pcm, sampleRate, synthMs } = r;
      post({ type: "pcm", runId: m.runId, seq: m.seq, start: m.start, end: m.end, sampleRate, pcm, phonemes: m.phonemes.length, synthMs }, [pcm.buffer as ArrayBuffer]);
      return;
    }
    if (m.type === "speak") {
      const model = await ensureLoaded();
      // A spoken message is short; if it ever exceeds the limit it is split like any text.
      const ph = await phonemize(m.text, LANGUAGE);
      let parts: string[];
      if (ph.length <= m.limits.limit) {
        parts = [ph];
      } else {
        const pieces = await splitTtsSafe(segmentSentences(m.text), (t) => phonemize(t, LANGUAGE), m.limits);
        parts = [];
        for (const p of pieces) parts.push(await phonemize(p.text, LANGUAGE));
      }
      const chunks: Float32Array[] = [];
      let sampleRate = 24000;
      let synthMs = 0;
      for (const p of parts) {
        const r = await synthesizePhonemes(model, p, m.voice, m.speed, m.limits.limit, m.runId);
        if (!r) return; // stopped before this part started
        chunks.push(r.pcm);
        sampleRate = r.sampleRate;
        synthMs += r.synthMs;
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const pcm = new Float32Array(total);
      let off = 0;
      for (const c of chunks) {
        pcm.set(c, off);
        off += c.length;
      }
      if (cancelled.has(m.runId)) return;
      post({ type: "pcm", runId: m.runId, seq: m.seq, start: -1, end: -1, sampleRate, pcm, phonemes: ph.length, synthMs }, [pcm.buffer as ArrayBuffer]);
      return;
    }
  } catch (err) {
    const runId = "runId" in m ? m.runId : -1;
    const seq = "seq" in m ? m.seq : -1;
    if (err instanceof TtsOverlimitError || (err instanceof Error && err.name === "tts_overlimit")) {
      const e2 = err as Error & { phonemes?: number; tokens?: number; limit?: number };
      post({ type: "overlimit", runId, seq, phonemes: e2.phonemes ?? e2.tokens ?? -1, limit: e2.limit ?? -1 });
      return;
    }
    post({ type: "error", runId, seq, name: err instanceof Error ? err.name : "Error", message: err instanceof Error ? err.message : String(err) });
  }
};
