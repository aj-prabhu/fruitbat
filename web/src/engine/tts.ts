// Main-thread voice engine (docs/PLAN.md S1-04). Drives workers/tts.worker.ts and the bounded
// AudioQueue; every control here is synchronous on the main thread so Esc never waits on a
// worker (Architecture -> "Concurrency model"). Rate 0.7–1.5 is applied per segment at synthesis
// (Kokoro `speed`) and persisted (C4). `speak(messageKey)` speaks a panel message from
// spec/strings/en.json (rule 8). Stats are a RunStats-shaped row (spec/schemas, S0-05).
import { AudioQueue, type QueueEvent } from "./audioQueue";
import { pinnedModels } from "./pins";
import { t } from "../strings";
import type { FromWorker, PlannedSegment, ToWorker } from "../workers/tts.worker";

export const RATE_MIN = 0.7;
export const RATE_MAX = 1.5;
export const VOICES = ["af_heart", "af_bella"] as const;
export type VoiceId = (typeof VOICES)[number];
const RATE_KEY = "fruitbat.rate";
/** Starting guess for English speech at 1.0x; the engine then learns the real rate from the audio it gets. */
const CHARS_PER_SECOND = 14;
const VOICE_KEY = "fruitbat.voice";
const STATS_KEY = "fruitbat.stats.last";
// The TTS-safe split, from spec/models.json (measured in S1-00a), not a second copy (Codex review, PR #17).
const LIMITS = { target: pinnedModels().web.voice.tts_phoneme_target, limit: pinnedModels().web.voice.tts_phoneme_limit };

export interface LoadedInfo {
  maxTokens: number;
  downloadedBytes: number;
  isolated: boolean;
  threads: number | null;
  cores: number;
  warmupMs: number;
}

export interface SegmentEvent {
  seq: number;
  start: number;
  end: number;
  at: number;
  seconds: number;
}

export interface ReadAllOptions {
  voice?: VoiceId;
  rate?: number;
  onStart?: (e: SegmentEvent) => void;
  onEnd?: (e: SegmentEvent) => void;
  onPlanned?: (segments: PlannedSegment[]) => void;
}

export interface ReadAllResult {
  runId: number;
  segments: number;
  coverage: number;
  ttsOverlimit: number;
  seconds: number;
  finished: boolean;
}

/** RunStats row (spec/schemas/run-stats.schema.json, S0-05). Numbers and enums only. */
export interface RunStatsRow {
  schema_version: 1;
  target: "web";
  device: "wasm" | "webgpu";
  level: "readall" | "short" | "caveman" | "oneline";
  browser: string;
  browser_major: number | null;
  os: string;
  os_major: number | null;
  cache_state: "cold" | "warm" | "unknown";
  model_id: string;
  model_rev: string;
  dtype: string;
  doc_id: string | null;
  commit: string | null;
  date: string;
  machine_id: string;
  ttfa_ms: number | null;
  gen_ms: number | null;
  tok_s: number | null;
  rtf: number | null;
  gap_ms: number | null;
  stop_ms: number | null;
  coverage: number | null;
  bullets_total: number | null;
  bullets_cut: number | null;
  cut_rate: number | null;
  facts_token_hit: number | null;
  halluc_flags: number | null;
  forbidden_hits: number | null;
  oneline_keyword_hit: number | null;
  tts_overlimit: number;
  peak_mb: number | null;
  heap_mb: number | null;
}

type Phase = "idle" | "loading" | "planning" | "reading" | "done" | "stopped" | "failed";

interface Env {
  browser: string;
  browser_major: number | null;
  os: string;
  os_major: number | null;
}

function detectEnv(): Env {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const pick = (re: RegExp) => {
    const m = re.exec(ua);
    return m ? Number(m[1]) : null;
  };
  let browser = "other";
  let browser_major: number | null = null;
  if (/Edg\//.test(ua)) (browser = "edge"), (browser_major = pick(/Edg\/(\d+)/));
  else if (/Firefox\//.test(ua)) (browser = "firefox"), (browser_major = pick(/Firefox\/(\d+)/));
  else if (/Chrome\//.test(ua)) (browser = "chrome"), (browser_major = pick(/Chrome\/(\d+)/));
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) (browser = "safari"), (browser_major = pick(/Version\/(\d+)/));
  let os = "other";
  let os_major: number | null = null;
  if (/iPhone|iPad/.test(ua)) (os = "ios"), (os_major = pick(/OS (\d+)_/));
  else if (/Android/.test(ua)) (os = "android"), (os_major = pick(/Android (\d+)/));
  else if (/Mac OS X/.test(ua)) (os = "macos"), (os_major = pick(/Mac OS X (\d+)/));
  else if (/Windows NT/.test(ua)) (os = "windows"), (os_major = pick(/Windows NT (\d+)/));
  else if (/Linux/.test(ua)) (os = "linux"), (os_major = null);
  return { browser, browser_major, os, os_major };
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // quota or private mode: the value simply does not persist
  }
}

export class VoiceEngine {
  private worker: Worker | null = null;
  private ctx: AudioContext | null = null;
  private queue: AudioQueue | null = null;
  private runId = 0;
  private messageSeq = 0;
  private waiters = new Map<string, { resolve: (m: FromWorker) => void; reject: (e: Error) => void }>();
  private loaded: Promise<LoadedInfo> | null = null;
  private messageSources: AudioBufferSourceNode[] = [];
  private lastStats: RunStatsRow | null = null;
  private progressListeners = new Set<(file: string, loaded: number, total: number) => void>();
  phase: Phase = "idle";
  error: string | null = null;
  current: SegmentEvent | null = null;
  next: PlannedSegment | null = null;
  private rate: number;
  private voice: VoiceId;
  private downloadedBytes = 0;

  constructor() {
    const r = Number(readStored(RATE_KEY));
    this.rate = Number.isFinite(r) && r >= RATE_MIN && r <= RATE_MAX ? r : 1;
    const v = readStored(VOICE_KEY);
    this.voice = (VOICES as readonly string[]).includes(v ?? "") ? (v as VoiceId) : "af_heart";
  }

  // ---------------------------------------------------------------- settings
  getRate(): number {
    return this.rate;
  }
  setRate(rate: number): number {
    const r = Math.min(RATE_MAX, Math.max(RATE_MIN, Number(rate) || 1));
    this.rate = Math.round(r * 100) / 100;
    writeStored(RATE_KEY, String(this.rate));
    return this.rate;
  }
  getVoice(): VoiceId {
    return this.voice;
  }
  setVoice(voice: string): VoiceId {
    if ((VOICES as readonly string[]).includes(voice)) {
      this.voice = voice as VoiceId;
      writeStored(VOICE_KEY, voice);
    }
    return this.voice;
  }
  onProgress(fn: (file: string, loaded: number, total: number) => void): () => void {
    this.progressListeners.add(fn);
    return () => this.progressListeners.delete(fn);
  }

  // ---------------------------------------------------------------- plumbing
  /** The AudioContext is created on first use; call from a user gesture so it can start. */
  ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 24000 });
      this.queue = new AudioQueue(this.ctx, {
        maxAheadSeconds: 30,
        maxInFlight: 3,
        onStart: (e) => this.handleStart(e),
        onEnd: (e) => this.handleEnd(e),
        onDrain: (id) => this.handleDrain(id),
      });
    }
    void this.ctx.resume();
    return this.ctx;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  getAnalyser(): AnalyserNode | null {
    return (this.queue?.getAnalyser() as AnalyserNode | null) ?? null;
  }

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("../workers/tts.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.handleMessage(e.data);
      this.worker.onerror = (e) => {
        this.error = `worker: ${e.message}`;
        for (const w of this.waiters.values()) w.reject(new Error(this.error));
        this.waiters.clear();
      };
    }
    return this.worker;
  }

  private send(msg: ToWorker): void {
    this.getWorker().postMessage(msg);
  }

  private wait(key: string): Promise<FromWorker> {
    return new Promise((resolve, reject) => this.waiters.set(key, { resolve, reject }));
  }

  private handleMessage(m: FromWorker): void {
    if (m.type === "progress") {
      for (const fn of this.progressListeners) fn(m.file, m.loaded, m.total);
      return;
    }
    if (m.type === "loaded") {
      this.downloadedBytes = m.downloadedBytes;
      this.waiters.get("loaded")?.resolve(m);
      this.waiters.delete("loaded");
      return;
    }
    if (m.type === "planned") {
      const key = `planned:${m.runId}`;
      this.waiters.get(key)?.resolve(m);
      this.waiters.delete(key);
      return;
    }
    if ((m.type === "error" || m.type === "overlimit") && m.seq === -1) {
      // A failure while loading (runId -1) or planning arrives without a seq: route it to that
      // waiter so load()/plan()/readAll() reject instead of hanging (Codex review, PR #17).
      const err = m.type === "error" ? new Error(`${m.name}: ${m.message}`) : new Error(`tts_overlimit: ${m.phonemes} > ${m.limit}`);
      const key = m.runId === -1 && this.waiters.has("loaded") ? "loaded" : `planned:${m.runId}`;
      const w = this.waiters.get(key);
      if (!w) return;
      this.waiters.delete(key);
      w.reject(err);
      return;
    }
    const key = `${m.runId}:${m.seq}`;
    const w = this.waiters.get(key);
    if (!w) return; // stale
    this.waiters.delete(key);
    w.resolve(m);
  }

  /** Reject every waiter that belongs to `runId` (a stopped run or a cancelled message). */
  private settleWaiters(runId: number, reason: string): void {
    const err = new Error(reason);
    err.name = "AbortError";
    for (const [key, w] of this.waiters) {
      if (key === `planned:${runId}` || key.startsWith(`${runId}:`)) {
        this.waiters.delete(key);
        w.reject(err);
      }
    }
  }

  /** Load the voice model (92 MB once, then cached). Idempotent. */
  load(): Promise<LoadedInfo> {
    if (!this.loaded) {
      this.phase = "loading";
      const p = this.wait("loaded").then((m) => {
        if (this.phase === "loading") this.phase = "idle";
        return m as LoadedInfo;
      });
      this.send({ type: "load" });
      this.loaded = p;
      p.catch(() => {
        this.loaded = null;
        this.phase = "failed";
      });
    }
    return this.loaded;
  }

  /** Segment + TTS-safe split only; nothing is synthesized. */
  async plan(text: string): Promise<{ segments: PlannedSegment[]; maxPhonemes: number; splitMs: number }> {
    const runId = -1 - ++this.messageSeq; // negative: never collides with a playback run
    const p = this.wait(`planned:${runId}`);
    this.send({ type: "plan", runId, text, limits: LIMITS });
    const m = (await p) as Extract<FromWorker, { type: "planned" }>;
    return { segments: m.segments, maxPhonemes: m.maxPhonemes, splitMs: m.splitMs };
  }

  // ---------------------------------------------------------------- read all
  private pendingDone: { resolve: (finished: boolean) => void } | null = null;
  private readSeq = 0;
  /** The stop time stop() measured, kept for the stats row of the run it stopped (Codex review, PR #17). */
  private lastStop: { runId: number; ms: number } | null = null;
  private runTtfa: number | null = null;
  private runT0 = 0;
  private runSynthMs = 0;
  private runOverlimit = 0;
  /** Seconds of audio per source character at 1.0x, the largest seen so far (kept across runs). */
  private secPerChar = 1 / CHARS_PER_SECOND;

  /** Estimated audio for a segment. Never below what the voice has actually produced per character,
   *  so a voice slower than the first guess still keeps the 30 s cap (Codex review, PR #17). */
  private estimateSeconds(seg: PlannedSegment, speed: number): number {
    return (Math.max(0, seg.end - seg.start) * this.secPerChar) / Math.max(speed, 0.1);
  }

  /**
   * Read `text` aloud in full: segment, split TTS-safe, synthesize in order under back-pressure,
   * play. Resolves when playback of the last segment ends, or when stopped.
   */
  async readAll(text: string, opts: ReadAllOptions = {}): Promise<ReadAllResult> {
    this.ensureContext();
    // Stop/Esc while the model loads bumps runId; a read requested before that must not start
    // afterwards (Codex review, PR #17).
    const before = this.runId;
    const ticket = ++this.readSeq; // several reads requested during the load: only the newest starts
    try {
      await this.load();
    } catch (e) {
      this.phase = "failed";
      this.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return this.result(before, 0, 0, false);
    }
    if (this.runId !== before || ticket !== this.readSeq) return this.result(before, 0, 0, false);
    const runId = ++this.runId;
    // A read already playing is replaced: settle its promise now, or its caller waits forever
    // (Codex review, PR #17).
    const replaced = this.pendingDone;
    this.pendingDone = null;
    replaced?.resolve(false);
    // ...and cancel its work in the worker, as stop() does, so its queued synthesis does not run
    // ahead of this read (Codex review, PR #17).
    this.send({ type: "cancel", runId: before });
    this.settleWaiters(before, "stopped");
    const queue = this.queue!;
    queue.beginRun(runId);
    this.phase = "planning";
    this.error = null;
    this.current = null;
    this.next = null;
    this.runTtfa = null;
    this.runSynthMs = 0;
    this.runOverlimit = 0;
    this.runT0 = performance.now();
    const voice = opts.voice ?? this.voice;
    const onStart = opts.onStart;
    const onEnd = opts.onEnd;
    this.userOnStart = onStart ?? null;
    this.userOnEnd = onEnd ?? null;

    const plannedP = this.wait(`planned:${runId}`);
    this.send({ type: "plan", runId, text, limits: LIMITS });
    let planned: Extract<FromWorker, { type: "planned" }>;
    try {
      planned = (await plannedP) as Extract<FromWorker, { type: "planned" }>;
    } catch (e) {
      // stop() during planning settles this waiter (Codex review, PR #17); a real planning
      // failure lands here too and fails the run cleanly.
      if (runId === this.runId) {
        this.phase = "failed";
        this.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
      return this.result(runId, 0, 0, false);
    }
    if (runId !== this.runId) return this.result(runId, planned.segments.length, 0, false);
    const segments = planned.segments;
    opts.onPlanned?.(segments);
    const coverage = coverageOf(text, segments);
    this.phase = "reading";
    this.next = segments[0] ?? null;

    let settle!: (finished: boolean) => void;
    const done = new Promise<boolean>((resolve) => (settle = resolve));
    this.pendingDone = { resolve: settle };
    if (segments.length === 0) {
      queue.close();
      this.phase = "done";
      settle(true);
    }

    // The driver: keep <= maxInFlight requests out and <= 30 s scheduled; results arrive in
    // order because each request is awaited in sequence (one at a time per slot).
    let nextSeq = 0;
    let firstError: unknown = null;
    const inflight = new Map<number, Promise<void>>();
    const pump = async (): Promise<void> => {
      while (nextSeq < segments.length && runId === this.runId && firstError === null) {
        // The rate is read per request, so moving the dial changes the segments not yet sent.
        // Admission counts this segment's estimated seconds, and each request reserves them until
        // it settles, so the 30 s cap covers audio still being synthesized (Codex review, PR #17).
        const seg = segments[nextSeq];
        const speed = opts.rate ?? this.rate;
        const est = this.estimateSeconds(seg, speed);
        if (!queue.canAccept(est)) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        nextSeq++;
        const ticket = queue.requestSent(est);
        // Every rejection is handled the moment it happens (no unhandled rejection while the
        // pump waits for capacity); the first one fails the run (Codex review, PR #17).
        const p = this.synthOne(runId, seg, voice, speed, queue)
          .catch((e: unknown) => {
            if (firstError === null) firstError = e;
          })
          .finally(() => {
            queue.requestSettled(ticket);
            inflight.delete(seg.seq);
          });
        inflight.set(seg.seq, p);
      }
      await Promise.all([...inflight.values()]);
      if (firstError !== null) throw firstError;
      if (runId === this.runId) queue.close();
    };
    void pump().catch((e: unknown) => {
      if (runId !== this.runId) return; // stopped: not a failure
      this.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.phase = "failed";
      this.pendingDone?.resolve(false);
    });

    const finished = await done;
    return this.result(runId, segments.length, coverage, finished, queue.totalSeconds);
  }

  private userOnStart: ((e: SegmentEvent) => void) | null = null;
  private userOnEnd: ((e: SegmentEvent) => void) | null = null;

  private async synthOne(runId: number, seg: PlannedSegment, voice: string, speed: number, queue: AudioQueue): Promise<void> {
    const key = `${runId}:${seg.seq}`;
    const p = this.wait(key);
    this.send({ type: "synth", runId, seq: seg.seq, phonemes: seg.phonemes, start: seg.start, end: seg.end, voice, speed, limit: LIMITS.limit });
    let m: FromWorker;
    try {
      m = await p;
    } catch (e) {
      if (runId !== this.runId) return; // stop() settled this waiter
      throw e;
    }
    if (runId !== this.runId) return;
    if (m.type === "pcm") {
      this.runSynthMs += m.synthMs;
      const chars = m.end - m.start;
      if (chars > 0) this.secPerChar = Math.max(this.secPerChar, ((m.pcm.length / m.sampleRate) * speed) / chars);
      queue.enqueue({ runId, seq: m.seq, pcm: m.pcm, sampleRate: m.sampleRate, start: m.start, end: m.end });
      return;
    }
    if (m.type === "overlimit") {
      this.runOverlimit++;
      throw new Error(`tts_overlimit: ${m.phonemes} > ${m.limit}`);
    }
    if (m.type === "error") throw new Error(`${m.name}: ${m.message}`);
  }

  private handleStart(e: QueueEvent): void {
    if (e.runId !== this.runId) return;
    if (this.runTtfa === null) this.runTtfa = performance.now() - this.runT0;
    this.current = { seq: e.seq, start: e.start, end: e.end, at: e.at, seconds: e.seconds };
    this.userOnStart?.(this.current);
  }

  private handleEnd(e: QueueEvent): void {
    if (e.runId !== this.runId) return;
    this.userOnEnd?.({ seq: e.seq, start: e.start, end: e.end, at: e.at, seconds: e.seconds });
    if (this.current?.seq === e.seq) this.current = null;
  }

  private handleDrain(runId: number): void {
    if (runId !== this.runId) return;
    this.phase = "done";
    this.pendingDone?.resolve(true);
    this.pendingDone = null;
  }

  private result(runId: number, segments: number, coverage: number, finished: boolean, seconds = 0): ReadAllResult {
    const q = this.queue!;
    const synthSeconds = this.runSynthMs / 1000;
    const row = this.buildRow({
      ttfa_ms: this.runTtfa === null ? null : Math.round(this.runTtfa),
      rtf: synthSeconds > 0 ? Math.round((seconds / synthSeconds) * 100) / 100 : null,
      gap_ms: Math.round(q.maxGapMs),
      stop_ms: this.lastStop?.runId === runId ? this.lastStop.ms : null, // a finished run has none
      coverage,
      tts_overlimit: this.runOverlimit,
    });
    this.lastStats = row;
    writeStored(STATS_KEY, JSON.stringify(row));
    return { runId, segments, coverage, ttsOverlimit: this.runOverlimit, seconds, finished };
  }

  private buildRow(partial: Partial<RunStatsRow>): RunStatsRow {
    const spec = pinnedModels().web.voice;
    const env = detectEnv();
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return {
      schema_version: 1,
      target: "web",
      device: "wasm",
      level: "readall",
      browser: env.browser,
      browser_major: env.browser_major,
      os: env.os,
      os_major: env.os_major,
      cache_state: this.loaded ? (this.downloadedBytes > 1_000_000 ? "cold" : "warm") : "unknown",
      model_id: spec.id,
      model_rev: spec.revision,
      dtype: spec.dtype,
      doc_id: null,
      commit: null,
      date: new Date().toISOString(),
      machine_id: "web",
      ttfa_ms: null,
      gen_ms: null,
      tok_s: null,
      rtf: null,
      gap_ms: null,
      stop_ms: null,
      coverage: null,
      bullets_total: null,
      bullets_cut: null,
      cut_rate: null,
      facts_token_hit: null,
      halluc_flags: null,
      forbidden_hits: null,
      oneline_keyword_hit: null,
      tts_overlimit: 0,
      peak_mb: null,
      heap_mb: mem ? Math.round(mem.usedJSHeapSize / 1e6) : null,
      ...partial,
    };
  }

  // ---------------------------------------------------------------- controls
  /** Stop everything within 200 ms. Returns the measured stop time in ms. */
  private pendingMessages = new Set<number>();
  private messageEpoch = 0;

  stop(): number {
    const t0 = performance.now();
    const stale = this.runId;
    this.runId++;
    this.send({ type: "cancel", runId: stale });
    this.queue?.stop();
    // Waiters of the stopped run (planning or synthesis in flight) settle now instead of hanging
    // on replies the worker suppresses for a cancelled run (Codex review, PR #17).
    this.settleWaiters(stale, "stopped");
    // A spoken message still being synthesized is cancelled too: its PCM is dropped on arrival.
    this.messageEpoch++;
    for (const seq of this.pendingMessages) {
      this.send({ type: "cancel", runId: -seq });
      this.settleWaiters(-seq, "stopped");
    }
    this.pendingMessages.clear();
    for (const s of this.messageSources.splice(0)) {
      try {
        s.stop();
      } catch {
        // already ended
      }
    }
    this.phase = "stopped";
    this.current = null;
    this.next = null;
    const stopMs = performance.now() - t0;
    this.lastStop = { runId: stale, ms: Math.round(stopMs * 100) / 100 };
    if (this.lastStats) {
      this.lastStats = { ...this.lastStats, stop_ms: Math.round(stopMs * 100) / 100 };
      writeStored(STATS_KEY, JSON.stringify(this.lastStats));
    }
    this.pendingDone?.resolve(false);
    this.pendingDone = null;
    return stopMs;
  }

  pause(): void {
    void this.queue?.pause();
  }
  resume(): void {
    void this.queue?.resume();
  }
  skip(): boolean {
    return this.queue?.skip() ?? false;
  }

  /** Speak a panel message from spec/strings/en.json (rule 8). Resolves when it has played. */
  async speak(messageKey: string): Promise<{ seconds: number }> {
    const ctx = this.ensureContext();
    // Taken before the load, so a Stop pressed while the model loads cancels this message too
    // (Codex review, PR #17).
    const epoch = this.messageEpoch;
    await this.load();
    if (epoch !== this.messageEpoch) return { seconds: 0 };
    const text = t(messageKey);
    const seq = ++this.messageSeq;
    const runId = -seq; // negative: independent of playback runs, still cancelled by stop()
    const p = this.wait(`${runId}:${seq}`);
    this.pendingMessages.add(seq);
    this.send({ type: "speak", runId, seq, text, voice: this.voice, speed: this.rate, limits: LIMITS });
    let m: FromWorker;
    try {
      m = await p;
    } catch (e) {
      if (epoch !== this.messageEpoch) return { seconds: 0 }; // stopped while synthesizing
      throw e;
    } finally {
      this.pendingMessages.delete(seq);
    }
    if (epoch !== this.messageEpoch) return { seconds: 0 }; // stop() raced the reply
    if (m.type !== "pcm") throw new Error(m.type === "error" ? `${m.name}: ${m.message}` : "tts_overlimit");
    const buf = ctx.createBuffer(1, m.pcm.length, m.sampleRate);
    buf.copyToChannel(m.pcm as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.getAnalyser() ?? ctx.destination);
    this.messageSources.push(src);
    const played = new Promise<void>((resolve) => {
      src.onended = () => {
        const i = this.messageSources.indexOf(src);
        if (i >= 0) this.messageSources.splice(i, 1);
        resolve();
      };
      // A context whose clock is not advancing (headless without an output) never fires onended;
      // resolve after the message's own duration so callers are not stuck.
      setTimeout(resolve, Math.ceil(buf.duration * 1000) + 500);
    });
    src.start();
    await played;
    return { seconds: buf.duration };
  }

  /** Synthesize `text` as pieces split at `target` phonemes and return the total audio seconds
   * without playing it. Used by the additivity and rate proofs (S1-04). */
  async measure(text: string, target: number, rate?: number): Promise<{ seconds: number; pieces: number; synthMs: number; maxPhonemes: number }> {
    await this.load();
    const runId = -1 - ++this.messageSeq;
    const plannedP = this.wait(`planned:${runId}`);
    this.send({ type: "plan", runId, text, limits: { target, limit: LIMITS.limit }, firstPieceTarget: 0 });
    const planned = (await plannedP) as Extract<FromWorker, { type: "planned" }>;
    let seconds = 0;
    let synthMs = 0;
    for (const seg of planned.segments) {
      const key = `${runId}:${seg.seq}`;
      const p = this.wait(key);
      this.send({ type: "synth", runId, seq: seg.seq, phonemes: seg.phonemes, start: seg.start, end: seg.end, voice: this.voice, speed: rate ?? this.rate, limit: LIMITS.limit });
      const m = await p;
      if (m.type !== "pcm") throw new Error(m.type === "error" ? `${m.name}: ${m.message}` : "tts_overlimit");
      seconds += m.pcm.length / m.sampleRate;
      synthMs += m.synthMs;
    }
    return { seconds, pieces: planned.segments.length, synthMs, maxPhonemes: planned.maxPhonemes };
  }

  state() {
    return {
      phase: this.phase,
      error: this.error,
      current: this.current,
      next: this.next,
      rate: this.rate,
      voice: this.voice,
      ctxState: this.ctx?.state ?? "none",
      aheadSeconds: this.queue?.aheadSeconds() ?? 0,
      inFlight: this.queue?.requestsInFlight ?? 0,
      playing: this.queue?.playing() ?? null,
      enqueued: this.queue?.enqueued ?? 0,
      ended: this.queue?.ended ?? 0,
    };
  }

  stats(): RunStatsRow | null {
    return this.lastStats;
  }
}

/** 1.0 when the segments tile the non-whitespace text with no gaps and no overlaps. */
export function coverageOf(text: string, segments: { start: number; end: number }[]): number {
  if (segments.length === 0) return text.trim().length === 0 ? 1 : 0;
  let prevEnd = 0;
  let ok = true;
  for (const s of segments) {
    if (s.start < prevEnd) ok = false;
    if (text.slice(prevEnd, s.start).trim().length > 0) ok = false;
    prevEnd = s.end;
  }
  if (text.slice(prevEnd).trim().length > 0) ok = false;
  if (ok) return 1;
  // Not a tiling. Report the share of non-whitespace source characters that lie inside some
  // segment (overlaps counted once), and never 1.0, so a gap or an overlap always fails the
  // coverage floor (Codex review, PR #17).
  const inside = new Uint8Array(text.length);
  for (const s of segments) inside.fill(1, Math.max(0, s.start), Math.min(text.length, s.end));
  let nonWs = 0;
  let hit = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    nonWs++;
    if (inside[i]) hit++;
  }
  return Math.min(nonWs === 0 ? 1 : hit / nonWs, 0.999);
}

let singleton: VoiceEngine | null = null;
export function voiceEngine(): VoiceEngine {
  if (!singleton) singleton = new VoiceEngine();
  return singleton;
}
