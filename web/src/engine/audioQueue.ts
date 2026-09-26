// Bounded PCM playback queue on an AudioContext (docs/PLAN.md S1-04; Architecture ->
// "Concurrency model": <= 3 TTS requests in flight, <= 30 s of PCM scheduled ahead; "Cancellation":
// stop <= 200 ms, playback cursor separate from generation, stale results dropped by runId).
//
// The queue owns scheduling only. It knows nothing about the worker; engine/tts.ts drives the
// worker and asks `canAccept()` before each request (back-pressure), then `enqueue()`s the PCM.
// Every method is synchronous so Esc on the main thread never waits on anything.

export interface PcmItem {
  runId: number;
  seq: number;
  pcm: Float32Array;
  sampleRate: number;
  /** source offsets of the spoken segment, or -1/-1 for a spoken message */
  start: number;
  end: number;
}

export interface QueueEvent {
  runId: number;
  seq: number;
  start: number;
  end: number;
  /** AudioContext clock (seconds) */
  at: number;
  /** seconds of audio in this item */
  seconds: number;
}

export interface AudioQueueOptions {
  maxAheadSeconds?: number;
  maxInFlight?: number;
  onStart?: (e: QueueEvent) => void;
  onEnd?: (e: QueueEvent) => void;
  /** fired once when the last enqueued item of a run has ended and nothing is scheduled */
  onDrain?: (runId: number) => void;
}

// The subset of AudioContext the queue uses, so tests can pass a fake.
export interface SourceLike {
  buffer: BufferLike | null;
  onended: ((ev: Event) => unknown) | null;
  connect(dest: unknown): unknown;
  start(when?: number): void;
  stop(when?: number): void;
}
export interface BufferLike {
  duration: number;
  copyToChannel(src: Float32Array, channel: number): void;
}
export interface AnalyserLike {
  connect(dest: unknown): unknown;
  fftSize: number;
}
export interface ContextLike {
  currentTime: number;
  state: string;
  destination: unknown;
  createBuffer(channels: number, length: number, sampleRate: number): BufferLike;
  createBufferSource(): SourceLike;
  createAnalyser?(): AnalyserLike;
  resume(): Promise<void>;
  suspend(): Promise<void>;
}

interface Scheduled {
  item: PcmItem;
  buffer: BufferLike;
  source: SourceLike;
  startAt: number;
  seconds: number;
  started: boolean;
  ended: boolean;
}

/** How often the audio clock is polled for start notifications (ms). */
const TICK_MS = 25;

const EPS = 0.005;

/** Handed out by requestSent(); settling it only counts for the run that sent it. */
export type RequestTicket = { run: number; seconds: number };

export class AudioQueue {
  readonly maxAheadSeconds: number;
  readonly maxInFlight: number;
  private readonly ctx: ContextLike;
  private readonly opts: AudioQueueOptions;
  private runId = 0;
  private nextStart = 0;
  private scheduled: Scheduled[] = [];
  private inFlight = 0;
  private analyser: AnalyserLike | null = null;
  /** worst underrun between consecutive items in the current run, ms */
  maxGapMs = 0;
  /** total seconds enqueued in the current run */
  totalSeconds = 0;
  /** items enqueued in the current run */
  enqueued = 0;
  /** items that finished playing in the current run */
  ended = 0;
  /** true once the driver says no more items will come for this run */
  private closed = false;
  /** Start notifications follow the AudioContext clock, not wall time: while the context is
   * suspended the clock stands still and nothing "starts" (Codex review, PR #17). */
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: ContextLike, opts: AudioQueueOptions = {}) {
    this.ctx = ctx;
    this.opts = opts;
    this.maxAheadSeconds = opts.maxAheadSeconds ?? 30;
    this.maxInFlight = opts.maxInFlight ?? 3;
  }

  get currentRunId(): number {
    return this.runId;
  }

  /** Start a new run: everything from the previous run is stopped and dropped. */
  beginRun(runId: number): void {
    this.stop();
    this.runId = runId;
    this.nextStart = this.ctx.currentTime;
    this.maxGapMs = 0;
    this.totalSeconds = 0;
    this.enqueued = 0;
    this.ended = 0;
    this.closed = false;
  }

  /** No more items will be enqueued for the current run (drain fires when playback ends). */
  close(): void {
    this.closed = true;
    this.maybeDrain();
  }

  /**
   * The driver calls these around each worker request so the in-flight bound holds. `seconds`
   * is the request's estimated audio, reserved against the ahead cap until it settles, so
   * three requests sent at 29 s buffered cannot push the queue far past 30 s (Codex review, PR #17).
   */
  requestSent(seconds = 0): RequestTicket {
    this.inFlight++;
    this.reserved += seconds;
    return { run: this.runId, seconds };
  }
  /** A request from a run that was stopped or replaced no longer counts against this run. */
  requestSettled(ticket: RequestTicket = { run: this.runId, seconds: 0 }): void {
    if (ticket.run !== this.runId) return;
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.reserved = Math.max(0, this.reserved - ticket.seconds);
  }
  private reserved = 0;
  get requestsInFlight(): number {
    return this.inFlight;
  }

  /** Seconds of audio scheduled beyond the context clock. */
  aheadSeconds(): number {
    return Math.max(0, this.nextStart - this.ctx.currentTime);
  }

  /**
   * Back-pressure: may the driver send a request for about `nextSeconds` of audio? Scheduled plus
   * reserved plus the new segment must fit the cap. A segment too long to ever fit is still let
   * through once the queue is nearly empty with nothing in flight, so playback cannot stall.
   */
  canAccept(nextSeconds = 0): boolean {
    if (this.inFlight >= this.maxInFlight) return false;
    const load = this.aheadSeconds() + this.reserved;
    if (load + nextSeconds <= this.maxAheadSeconds && load < this.maxAheadSeconds) return true;
    return this.inFlight === 0 && load <= Math.min(5, this.maxAheadSeconds / 2);
  }

  /** Analyser between the sources and the destination, for Pip (S1-08). Null on a fake context. */
  getAnalyser(): AnalyserLike | null {
    if (!this.analyser && this.ctx.createAnalyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.connect(this.ctx.destination);
    }
    return this.analyser;
  }

  /** Schedule PCM right after whatever is already scheduled. Returns false for a stale runId. */
  enqueue(item: PcmItem): boolean {
    if (item.runId !== this.runId || this.closed) return false;
    const buffer = this.ctx.createBuffer(1, item.pcm.length, item.sampleRate);
    buffer.copyToChannel(item.pcm, 0);
    const now = this.ctx.currentTime;
    const startAt = Math.max(now, this.nextStart);
    if (this.enqueued > 0) {
      const gap = (startAt - this.nextStart) * 1000;
      if (gap > this.maxGapMs) this.maxGapMs = gap;
    }
    const s = this.schedule(item, buffer, startAt);
    this.nextStart = startAt + s.seconds;
    this.totalSeconds += s.seconds;
    this.enqueued++;
    return true;
  }

  private schedule(item: PcmItem, buffer: BufferLike, startAt: number): Scheduled {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.getAnalyser() ?? this.ctx.destination);
    const s: Scheduled = { item, buffer, source, startAt, seconds: buffer.duration, started: false, ended: false };
    source.onended = () => {
      if (s.ended) return;
      s.ended = true;
      const i = this.scheduled.indexOf(s);
      if (i >= 0) this.scheduled.splice(i, 1);
      if (item.runId === this.runId) {
        this.ended++;
        this.opts.onEnd?.({ runId: item.runId, seq: item.seq, start: item.start, end: item.end, at: this.ctx.currentTime, seconds: s.seconds });
        this.maybeDrain();
      }
    };
    source.start(startAt);
    this.scheduled.push(s);
    this.ensureTicker();
    this.tick();
    return s;
  }

  private ensureTicker(): void {
    if (this.ticker === null) this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  /** Fire onStart for every scheduled item whose start time the audio clock has reached. */
  private tick(): void {
    const now = this.ctx.currentTime;
    for (const s of this.scheduled) {
      if (s.started || s.ended || s.item.runId !== this.runId) continue;
      if (now + EPS >= s.startAt) {
        s.started = true;
        this.opts.onStart?.({ runId: s.item.runId, seq: s.item.seq, start: s.item.start, end: s.item.end, at: s.startAt, seconds: s.seconds });
      }
    }
    if (this.scheduled.length === 0 && this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private maybeDrain(): void {
    if (this.closed && this.scheduled.length === 0 && this.enqueued > 0 && this.ended >= this.enqueued) {
      const id = this.runId;
      this.closed = false;
      this.opts.onDrain?.(id);
    }
  }

  /** The item whose window contains the context clock, or null. */
  playing(): PcmItem | null {
    const now = this.ctx.currentTime;
    for (const s of this.scheduled) {
      if (!s.ended && now + EPS >= s.startAt && now < s.startAt + s.seconds) return s.item;
    }
    return null;
  }

  /** Stop everything scheduled, drop the rest, invalidate the run. Returns the wall time it took (ms). */
  stop(): number {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    for (const s of this.scheduled) {
      s.ended = true;
      try {
        s.source.stop();
      } catch {
        // never started or already ended
      }
    }
    this.scheduled = [];
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    this.nextStart = this.ctx.currentTime;
    this.runId++;
    this.closed = false;
    this.inFlight = 0;
    this.reserved = 0;
    return (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  }

  pause(): Promise<void> {
    return this.ctx.suspend();
  }

  resume(): Promise<void> {
    return this.ctx.resume();
  }

  /** Stop the item playing now and pull the rest forward to start immediately. */
  skip(): boolean {
    const now = this.ctx.currentTime;
    const idx = this.scheduled.findIndex((s) => !s.ended && now + EPS >= s.startAt && now < s.startAt + s.seconds);
    if (idx < 0) return false;
    const rest = this.scheduled.slice(idx + 1);
    const current = this.scheduled[idx];
    // Silence the current one and every later source; a started BufferSourceNode cannot restart.
    for (const s of [current, ...rest]) {
      s.ended = true;
      try {
        s.source.stop();
      } catch {
        // already ended
      }
    }
    this.scheduled = this.scheduled.slice(0, idx);
    this.ended++;
    this.opts.onEnd?.({ runId: current.item.runId, seq: current.item.seq, start: current.item.start, end: current.item.end, at: now, seconds: current.seconds });
    let at = now;
    for (const s of rest) {
      const re = this.schedule(s.item, s.buffer, at);
      at += re.seconds;
    }
    this.nextStart = at;
    this.maybeDrain();
    return true;
  }
}
