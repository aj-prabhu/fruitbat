// The orchestrator (docs/PLAN.md S1-06): one object owns the voice engine and the summarizer and
// runs the two state machines (engine/state.ts). Everything user-facing goes through it:
// run / stop / pause / resume / skip / setLevel / readThisPart. Rules it enforces:
//  - Cancellation: a monotonic runId; stop, dial change and new input bump it, abort the LLM,
//    drop queued TTS work and stop playback ≤ 200 ms; every late callback checks the id.
//  - "Dial change never goes silent": the notice is spoken the instant the dial moves (its PCM
//    is prewarmed), while the chunk under the playback cursor regenerates at the new level.
//  - Rule 2: an all-cut chunk is announced and "Read this part" is offered; it never auto-plays.
//  - Rule 8: every notice is spoken (speakMessages, default on, persisted).
//  - Rule 11: the voice loads on page load (not on data saver / mobile); the summarizer only
//    downloads on the first summary request.
// Notices are string KEYS from spec/strings/en.json; the UI and the voice render them.
import dialSpec from "../../../spec/dial.json";
import type { Chunk } from "../core/chunk";
import type { Level } from "../types";
import type { PlannedSegment } from "../workers/tts.worker";
import { isMobile, parseFlags, saveData } from "./capabilities";
import { Summarizer, type BulletOut, type NoticeOut, type RunStats as GenStats } from "./llm";
import { isActive, reduceGen, reducePlay, type GenState, type PlayState } from "./state";
import { voiceEngine, type RunStatsRow, type StreamMetrics, type VoiceEngine } from "./tts";

const ORDER = (dialSpec.levels as { id: string }[]).map((l) => l.id as Level);
const DEFAULT_LEVEL = (dialSpec.default as Level) ?? "short";
const SPEAK_KEY = "fruitbat.speakMessages";

/** Messages synthesized right after the voice loads, so they start within milliseconds. */
export const PREWARM_KEYS = [
  "notice.dial_shorter",
  "notice.dial_longer",
  "notice.stopped",
  "notice.all_cut",
  "notice.oneline_failed",
  "notice.input_limit",
  "notice.done",
];

export type Cursor =
  | { kind: "bullet"; chunkIndex: number; index: number }
  | { kind: "sentence"; start: number; end: number; text: string; next: string | null };

export interface Snapshot {
  gen: GenState;
  play: PlayState;
  level: Level;
  runId: number;
  bullets: BulletOut[];
  current: Cursor | null;
  /** chunk indexes whose bullets were all cut (rule 2: "Read this part" is offered) */
  allCut: number[];
  notices: string[];
  lastNotice: string | null;
  chunks: number;
  voiceReady: boolean;
  prewarmed: boolean;
  speakMessages: boolean;
  progress: { file?: string; loaded?: number; total?: number } | null;
  error: string | null;
  voice: { aheadSeconds: number; enqueued: number; inFlight: number; ended: number; pending: number; phase: string };
}

export interface OrchestratorStats {
  runs: number;
  last: { level: Level; chars: number } | null;
  ttfa_ms: number | null;
  stop_ms: number | null;
  notice_latency_ms: number | null;
  notices_spoken: string[];
  gen: GenStats | null;
  voice: RunStatsRow | null;
  voice_run: StreamMetrics | null;
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
    // private mode / quota: the setting does not persist
  }
}

export class Orchestrator {
  readonly voice: VoiceEngine;
  readonly llm: Summarizer;
  gen: GenState = "idle";
  play: PlayState = "idle";
  level: Level = DEFAULT_LEVEL;
  speakMessages: boolean;
  bullets: BulletOut[] = [];
  allCut: number[] = [];
  notices: string[] = [];
  lastNotice: string | null = null;
  current: Cursor | null = null;
  error: string | null = null;
  progress: Snapshot["progress"] = null;
  private runId = 0;
  private text = "";
  private chunks: Chunk[] | null = null;
  private voiceReady = false;
  private listeners = new Set<(s: Snapshot) => void>();
  private runs = 0;
  private last: OrchestratorStats["last"] = null;
  private ttfa: number | null = null;
  private runT0 = 0;
  private stopMs: number | null = null;
  private noticeLatency: number | null = null;
  private spoken: string[] = [];
  private genStats: GenStats | null = null;
  private voiceRun: StreamMetrics | null = null;

  constructor(voice: VoiceEngine = voiceEngine(), llm: Summarizer = new Summarizer(parseFlags())) {
    this.voice = voice;
    this.llm = llm;
    this.speakMessages = readStored(SPEAK_KEY) !== "off";
    llm.onNotice = (n) => this.onLlmNotice(n);
    llm.onProgress = (p) => {
      this.progress = p;
      this.emit();
    };
    // Rule 11: the voice loads on page load, except on data saver / mobile. (No Worker = a unit
    // test environment: nothing loads, nothing is reported.)
    if (typeof Worker !== "undefined" && !saveData() && !isMobile()) void this.warmVoice();
  }

  /** The voice has loaded, by page-load warm-up or on demand: notices held until now are spoken.
   *  On mobile / data saver there is no warm-up, so the first run's load does this (Codex review, PR #18). */
  private markVoiceReady(): void {
    if (this.voiceReady) return;
    this.voiceReady = true;
    this.emit();
    for (const key of this.pendingNotices.splice(0)) this.notice(key);
  }

  /** A prewarm cut short by a run (Stop cancels the notice being synthesized) finishes once the
   *  run has played out, when the worker is free again (Codex review, PR #18). */
  private finishPrewarm(): void {
    if (this.voiceReady && !this.voice.prewarmed) void this.voice.prewarm(PREWARM_KEYS).catch(() => undefined);
  }

  private async warmVoice(): Promise<void> {
    try {
      await this.voice.load();
      this.markVoiceReady();
      await this.voice.prewarm(PREWARM_KEYS);
    } catch (e) {
      this.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.notice("error.voice");
    }
    this.emit();
  }

  // ---------------------------------------------------------------- observation
  subscribe(fn: (s: Snapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): Snapshot {
    const v = this.voice.state();
    return {
      gen: this.gen,
      play: this.play,
      level: this.level,
      runId: this.runId,
      bullets: [...this.bullets],
      current: this.current,
      allCut: [...this.allCut],
      notices: [...this.notices],
      lastNotice: this.lastNotice,
      chunks: this.chunks?.length ?? 0,
      voiceReady: this.voiceReady,
      prewarmed: this.voice.prewarmed,
      speakMessages: this.speakMessages,
      progress: this.progress,
      error: this.error,
      voice: { aheadSeconds: v.aheadSeconds, enqueued: v.enqueued, inFlight: v.inFlight, ended: v.ended, pending: v.pending, phase: v.phase },
    };
  }

  private emit(): void {
    const s = this.snapshot();
    for (const l of this.listeners) l(s);
  }

  stats(): OrchestratorStats {
    return {
      runs: this.runs,
      last: this.last,
      ttfa_ms: this.ttfa === null ? null : Math.round(this.ttfa),
      stop_ms: this.stopMs === null ? null : Math.round(this.stopMs * 100) / 100,
      notice_latency_ms: this.noticeLatency,
      notices_spoken: [...this.spoken],
      gen: this.genStats ?? (this.level === "readall" ? null : this.llm.stats()), // a Read-all run has no summarizer stats (Codex review, PR #22)
      voice: this.voice.stats(),
      voice_run: this.voiceRun,
    };
  }

  setSpeakMessages(on: boolean): void {
    this.speakMessages = on;
    writeStored(SPEAK_KEY, on ? "on" : "off");
    this.emit();
  }

  // ---------------------------------------------------------------- notices
  private onLlmNotice(n: NoticeOut): void {
    // The summarizer says "stopped" whenever its load or run is aborted, including by a dial
    // change or new input. Only the orchestrator knows the user pressed Stop, and says so itself
    // (Codex review, PR #18).
    if (n.key === "notice.stopped") return;
    if (n.key === "notice.all_cut" && n.chunkIndex !== undefined && !this.allCut.includes(n.chunkIndex)) this.allCut.push(n.chunkIndex);
    this.notice(n.key);
  }

  /** Show a notice (a key) and, with speakMessages on, speak it. `sinceMs` measures the latency
   *  from an earlier trigger (the dial move) to the first spoken sample. */
  private pendingNotices: string[] = [];

  private notice(key: string, sinceMs?: number): void {
    this.notices.push(key);
    this.lastNotice = key;
    this.emit();
    if (!this.speakMessages) return;
    if (!this.voiceReady) {
      // e.g. notice.no_webgpu on a page whose voice is still loading: spoken as soon as it is
      // (Codex review, PR #18)
      this.pendingNotices.push(key);
      return;
    }
    this.spoken.push(key);
    void this.voice
      .speak(key, sinceMs)
      .then(() => {
        if (sinceMs !== undefined) {
          this.noticeLatency = this.voice.lastNoticeLatencyMs;
          this.emit();
        }
      })
      .catch(() => {
        // the notice is on screen; a failed synthesis is not a second error
      });
  }

  // ---------------------------------------------------------------- runs
  /** Stop whatever runs (LLM aborted, queued TTS dropped, playback silenced ≤ 200 ms) and take a
   *  new run id. Every callback of the old run checks the id and drops itself. */
  /** Aborts the summary of the current run, even one still queued behind a draining worker,
   *  which llm.abort() alone cannot reach (Codex review, PR #18). */
  private runAbort: AbortController | null = null;

  private newRun(): number {
    const id = ++this.runId;
    // Notices held for a voice still loading belong to the run being replaced (Codex review, PR #18).
    this.pendingNotices = [];
    this.runAbort?.abort();
    this.runAbort = new AbortController();
    this.llm.abort();
    this.stopMs = this.voice.stop();
    this.gen = reduceGen(this.gen, "stop");
    this.play = reducePlay(this.play, "stop");
    return id;
  }

  /** New input at `level`. Resolves when the run has settled (done, failed, or superseded). */
  run(text: string, level: Level): Promise<void> {
    // Create and resume the AudioContext while the click's user activation is live: Safari
    // loses it at the first await (the model download), so this must be the first statement
    // (Codex review, PRs #20/#21).
    this.voice.ensureContext();
    this.runs++;
    this.last = { level, chars: text.length };
    this.text = text;
    this.level = level;
    this.chunks = null;
    this.notices = [];
    this.lastNotice = null;
    const id = this.newRun();
    return this.begin(id, level, { fromChunk: 0, base: 0, end: text.length });
  }

  /** Esc. Returns the measured stop time in ms. */
  stop(): number {
    const active = isActive(this.gen, this.play);
    this.newRun();
    this.current = null;
    this.progress = null;
    this.emit();
    if (active) this.notice("notice.stopped");
    return this.stopMs ?? 0;
  }

  pause(): void {
    if (this.play !== "playing") return;
    this.voice.pause();
    this.play = reducePlay(this.play, "pause");
    this.emit();
  }

  resume(): void {
    if (this.play !== "paused") return;
    this.voice.resume();
    this.play = reducePlay(this.play, "resume");
    this.emit();
  }

  skip(): boolean {
    return this.voice.skip();
  }

  /**
   * The dial moved. With nothing running it only arms the next run. Mid-run: the notice is spoken
   * at once and the run restarts at the new level from the chunk under the playback cursor
   * ("Making it shorter." / "Adding detail.", ≤ 500 ms).
   */
  async setLevel(level: Level): Promise<void> {
    const t0 = performance.now();
    const prev = this.level;
    if (level === prev) return;
    this.level = level;
    if (!this.busy() || !this.text) {
      this.emit();
      return;
    }
    const shorter = ORDER.indexOf(level) > ORDER.indexOf(prev);
    // Bump the run and speak before anything is awaited: the chunk lookup can wait on the
    // tokenizer, and a Stop in that window must win (Codex review, PR #18).
    const id = this.newRun();
    this.notice(shorter ? "notice.dial_shorter" : "notice.dial_longer", t0);
    // Until the chunk lookup returns, the regeneration is pending: a second dial move in that
    // window replaces it instead of just arming the level (Codex review, PR #18).
    this.regenPending = id;
    const chunkIndex = await this.currentChunkIndex();
    if (this.regenPending === id) this.regenPending = null;
    if (id !== this.runId) return;
    const c = this.chunks?.[chunkIndex];
    await this.begin(id, level, { fromChunk: chunkIndex, base: c?.start ?? 0, end: this.text.length });
  }

  /** Active generation or playback, or speech still being synthesized for this run (a finished
   *  generation whose first bullet's audio is not out yet is still a run; Codex review, PR #18). */
  private regenPending: number | null = null;

  private busy(): boolean {
    if (this.regenPending === this.runId) return true;
    if (isActive(this.gen, this.play)) return true;
    if (this.play === "stopped") return false; // Esc'd audio is not a run to regenerate (Codex review, PR #20)
    const v = this.voice.state();
    // A bullet still loading the voice or being phonemized is speech on its way (Codex review, PR #18).
    return v.pending > 0 || v.inFlight > 0 || v.enqueued > v.ended;
  }

  /** Rule 2: read an all-cut chunk aloud, on request only. */
  async readThisPart(chunkIndex: number): Promise<void> {
    // The run is taken before the chunk lookup, so a Stop or a new run in that window wins
    // (Codex review, PR #18).
    const id = this.newRun();
    const chunks = await this.ensureChunks();
    if (id !== this.runId) return;
    const c = chunks?.[chunkIndex];
    if (!c) return;
    // Reading one part keeps the summary and every other part's "Read this part" key (Codex review, PR #18).
    await this.begin(id, "readall", { fromChunk: chunkIndex, base: c.start, end: c.end, keep: true });
  }

  private async ensureChunks(): Promise<Chunk[] | null> {
    if (this.chunks) return this.chunks;
    if (!this.text) return null;
    const text = this.text;
    let chunks: Chunk[] | null = null;
    try {
      chunks = await this.llm.chunk(text);
    } catch {
      chunks = null; // input limit: summarize() reports it
    }
    // A new input may have arrived while tokenizing: never cache a stale result (Codex review, PR #21).
    if (text !== this.text) return null;
    this.chunks = chunks;
    return this.chunks;
  }

  /** The chunk containing the playback cursor; else the chunk being generated; else 0. */
  private async currentChunkIndex(): Promise<number> {
    const cur = this.current;
    if (cur?.kind === "bullet") return cur.chunkIndex;
    const chunks = await this.ensureChunks();
    if (!chunks) return 0;
    if (cur?.kind === "sentence") {
      const i = chunks.findIndex((c) => cur.start >= c.start && cur.start < c.end);
      return i >= 0 ? i : 0;
    }
    const lastBullet = this.bullets[this.bullets.length - 1];
    return lastBullet ? lastBullet.chunkIndex : 0;
  }

  private async begin(id: number, level: Level, o: { fromChunk: number; base: number; end: number; keep?: boolean }): Promise<void> {
    this.last = { level, chars: o.end - o.base }; // dial regeneration and "Read this part" are runs too (Codex review, PR #22)
    this.play = reducePlay(this.play, "reset");
    if (!o.keep) {
      this.bullets = [];
      this.allCut = [];
    }
    this.current = null;
    this.error = null;
    this.ttfa = null;
    this.runT0 = performance.now();
    this.voiceRun = null;
    this.genStats = null;
    this.gen = reduceGen(this.gen, "start");
    this.emit();
    try {
      if (level === "readall") await this.readAloud(id, o.base, o.end);
      else await this.summarize(id, level as Exclude<Level, "readall">, o.fromChunk);
    } catch (e) {
      if (id !== this.runId) return;
      this.gen = reduceGen(this.gen, "fail");
      this.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.notice("error.generation");
    }
    this.emit();
  }

  private markAudio(): void {
    if (this.ttfa === null) this.ttfa = performance.now() - this.runT0;
    this.play = reducePlay(this.play, "audio");
  }

  private async readAloud(id: number, base: number, end: number): Promise<void> {
    const slice = this.text.slice(base, end);
    let planned: PlannedSegment[] = [];
    await this.voice.load();
    if (id !== this.runId) return;
    this.markVoiceReady();
    this.gen = reduceGen(this.gen, "loaded");
    this.emit();
    const r = await this.voice.readAll(slice, {
      onPlanned: (segs) => {
        planned = segs;
      },
      onStart: (e) => {
        if (id !== this.runId) return;
        this.markAudio();
        this.current = { kind: "sentence", start: base + e.start, end: base + e.end, text: slice.slice(e.start, e.end), next: planned[e.seq + 1]?.text ?? null };
        this.emit();
      },
    });
    if (id !== this.runId) return;
    if (this.voice.phase === "failed") {
      this.gen = reduceGen(this.gen, "fail");
      this.error = this.voice.error;
      this.notice("error.voice");
      return;
    }
    this.gen = reduceGen(this.gen, "finish");
    this.voiceRun = this.voice.metrics(r.seconds);
    if (r.finished) {
      this.play = reducePlay(this.play, "drain");
      this.current = null;
      this.notice("notice.done");
      this.finishPrewarm();
    }
  }

  private async summarize(id: number, level: Exclude<Level, "readall">, fromChunk: number): Promise<void> {
    // On demand where there was no page-load warm-up (mobile / data saver): the summary is the demand.
    void this.voice.load().then(
      () => {
        this.markVoiceReady();
        // No page-load warm-up on mobile / data saver: prewarm the dial notices now, so the next
        // dial move still speaks within 500 ms (Codex review, PR #18).
        void this.voice.prewarm(PREWARM_KEYS).catch(() => undefined);
      },
      () => undefined, // a failed voice load surfaces through the stream's own end
    );
    const streamId = this.voice.beginStream({
      onStart: (e) => {
        if (id !== this.runId) return;
        this.markAudio();
        const b = e.tag === undefined ? undefined : this.bullets[e.tag];
        if (b) this.current = { kind: "bullet", chunkIndex: b.chunkIndex, index: e.tag as number };
        this.emit();
      },
    });
    // The run's own signal goes to both attempts, so Esc also cancels a load waiting on a drain.
    const signal = this.runAbort?.signal;
    let ok = await this.llm.ensureLoaded({ signal });
    // A newer run's newRun() aborts the load an older run started; if this run joined that load,
    // start it again rather than failing (Codex review, PR #18).
    if (!ok && id === this.runId && this.llm.error === "aborted") ok = await this.llm.ensureLoaded({ signal });
    if (id !== this.runId) return;
    if (!ok) {
      this.gen = reduceGen(this.gen, "fail");
      this.error = this.llm.error;
      // End the empty stream rather than voice.stop(), which would also cancel the failure notice
      // the summarizer just raised (Codex review, PR #18).
      void this.voice.endStream(streamId);
      this.play = reducePlay(this.play, "reset");
      return;
    }
    this.gen = reduceGen(this.gen, "loaded");
    this.emit();
    await this.ensureChunks();
    if (id !== this.runId) return;
    const stats = await this.llm.summarize(this.text, level, {
      signal: this.runAbort?.signal,
      fromChunk,
      onBullet: (b) => {
        if (id !== this.runId) return;
        const idx = this.bullets.push(b) - 1;
        this.emit();
        void this.voice.pushText(streamId, b.text, b.start, b.end, idx);
      },
    });
    if (id !== this.runId) return;
    this.genStats = stats;
    if (this.llm.state === "failed") {
      this.gen = reduceGen(this.gen, "fail");
      this.error = this.llm.error;
    } else {
      this.gen = reduceGen(this.gen, "finish");
    }
    this.emit();
    const { finished, metrics } = await this.voice.endStream(streamId);
    if (id !== this.runId) return;
    this.voiceRun = metrics;
    if (!finished) {
      // The stream ended without playing out (a failure stopped the queue): the panel must not
      // keep showing a bullet as playing (Codex review, PR #18).
      this.play = reducePlay(this.play, "stop");
      this.current = null;
    }
    if (!finished && this.gen === "done") {
      // the summary is complete but its speech failed (voice load, planning or synthesis):
      // say so instead of ending silently (Codex review, PR #18)
      this.error = this.error ?? "voice_failed";
      this.notice("error.voice");
    }
    if (finished) {
      this.play = reducePlay(this.play, "drain");
      this.current = null;
      // "Done" only when something was said; an all-cut summary keeps "Couldn't make a summary I
      // trust for this part" and its Read this part key (Codex review, PR #18).
      if (this.gen === "done" && this.bullets.length > 0) this.notice("notice.done");
      this.finishPrewarm();
    }
  }
}

let singleton: Orchestrator | null = null;
export function orchestrator(): Orchestrator {
  if (!singleton) singleton = new Orchestrator();
  return singleton;
}
