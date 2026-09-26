// The summarizer engine, main-thread side (docs/PLAN.md S1-05). Owns: the two-stage probe, the
// on-demand download (rule 11), chunking → generation → parsing → grounding, the One-line
// reduce policy, cancellation by runId, and the run's stats. The model itself lives in
// workers/llm.worker.ts (or llm.fake.worker.ts under ?llm=fake). No string literal shown to a
// user comes from here: notices are string KEYS from spec/strings/en.json; the panel speaks them.
import dialSpec from "../../../spec/dial.json";
import shortPrompt from "../../../spec/prompts/short.md?raw";
import cavemanPrompt from "../../../spec/prompts/caveman.md?raw";
import onelinePrompt from "../../../spec/prompts/oneline.md?raw";
import reducePrompt from "../../../spec/prompts/reduce-oneline.md?raw";
import { BulletParser, COMMON_WORDS, InputLimitError, chunkSentences, countTokens, ground, segmentSentences, type Chunk } from "../core";
import { parseFlags, probeWebGpu, type Flags, type GpuProbe } from "./capabilities";
import type { GenerateMsg, Level, MainToWorker, WorkerToMain } from "./llmProtocol";
import { summarizerTiers, type PinnedModel } from "./pins";

export type { Level };
export type GenState = "idle" | "probing" | "loading" | "running" | "done" | "failed" | "stopped";

/** spec/chunking.md "Token budgets". */
export const BUDGET = { chunk_input_tokens: 1600, max_chunks: 100 };
/** Longest the next run waits for the worker to confirm a Stop (one uninterruptible prefill). */
const ABORT_DRAIN_MS = 15_000;

interface DialLevel {
  id: string;
  prompt?: string;
  reduce_prompt?: string;
  max_bullets_per_chunk?: number;
  min_bullets_per_chunk?: number;
  max_words_per_bullet?: number;
  max_new_tokens?: number;
  reduce?: { group_size: number; max_depth: number; fallback_level: string; max_cut_fraction: number };
}
const LEVELS = new Map((dialSpec.levels as DialLevel[]).map((l) => [l.id, l]));
const PROMPTS: Record<string, string> = {
  "prompts/short.md": shortPrompt,
  "prompts/caveman.md": cavemanPrompt,
  "prompts/oneline.md": onelinePrompt,
  "prompts/reduce-oneline.md": reducePrompt,
};

/** Bake-off variant only (docs/qa/prompt-tryouts-2026-09-24.md): a system message on top of the level prompt. */
const SYSTEM_VARIANT =
  "You write summaries for people who tire when reading. Obey the bullet count exactly. Output only the bullet lines, nothing before or after.";

export interface BulletOut {
  text: string;
  chunkIndex: number; // -1 for the final One line
  index: number;
  start: number;
  end: number;
}
export interface NoticeOut {
  key: string; // spec/strings/en.json key
  chunkIndex?: number;
  start?: number;
  end?: number;
}
export interface RunStats {
  level: Level | null;
  level_used: Level | null;
  chunks: number;
  bullets_total: number;
  bullets_cut: number;
  all_cut_chunks: number;
  parser_dropped: number;
  parser_overlength: number;
  reduce_calls: number;
  ttfa_ms: number | null;
  gen_ms: number;
  tokens: number;
  tok_s: number | null;
  model_id: string | null;
  role: string | null;
  downgraded: boolean;
  load_ms: number | null;
  probe_ms: number | null;
  per_chunk_kept: number[];
}
export interface SummarizeOptions {
  signal?: AbortSignal;
  onBullet?: (b: BulletOut) => void;
  onNotice?: (n: NoticeOut) => void;
  onToken?: (text: string) => void;
}

type Pending = {
  runId: number;
  chunkIndex: number;
  onToken: (text: string) => void;
  resolve: (r: { tokens: number; ms: number; aborted: boolean }) => void;
  reject: (e: Error) => void;
};

function emptyStats(): RunStats {
  return {
    level: null,
    level_used: null,
    chunks: 0,
    bullets_total: 0,
    bullets_cut: 0,
    all_cut_chunks: 0,
    parser_dropped: 0,
    parser_overlength: 0,
    reduce_calls: 0,
    ttfa_ms: null,
    gen_ms: 0,
    tokens: 0,
    tok_s: null,
    model_id: null,
    role: null,
    downgraded: false,
    load_ms: null,
    probe_ms: null,
    per_chunk_kept: [],
  };
}

export class Summarizer {
  readonly flags: Flags;
  state: GenState = "idle";
  gpu: GpuProbe | null = null;
  error: string | null = null;
  private worker: Worker | null = null;
  private runId = 0;
  private loaded = false;
  private modelSpec: (PinnedModel & { role: string }) | null = null;
  private pending: Pending | null = null;
  /** In-flight model load, shared by overlapping callers (Codex review, PR #16). */
  private loading: Promise<boolean> | null = null;
  /** Settles once the worker confirms the last Stop, so the next run never overlaps it. */
  private drain: Promise<void> | null = null;
  /** A Stop pressed during the adapter probe, before anything reached the worker. */
  private stopDuringProbe = false;
  /** The current run's options, so its own onNotice hears the notices it raises. */
  private runOpts: SummarizeOptions | null = null;
  private waiters = new Map<string, { resolve: (m: WorkerToMain) => void; reject: (e: Error) => void }>();
  private modelRequests = 0; // model files requested (one per Transformers.js "initiate")
  private runStats: RunStats = emptyStats();
  private notices: NoticeOut[] = [];
  private lastProgress: { file?: string; loaded?: number; total?: number } | null = null;
  onNotice: ((n: NoticeOut) => void) | null = null;
  onProgress: ((p: { file?: string; loaded?: number; total?: number }) => void) | null = null;

  constructor(flags: Flags = parseFlags()) {
    this.flags = flags;
  }

  /** The tier the loader will ask for: `?model=<role>` for the bake-off, else the default. */
  tier(): PinnedModel & { role: string } {
    const tiers = summarizerTiers();
    return tiers.find((t) => t.role === this.flags.model) ?? tiers[0];
  }

  /** Bytes the first summary request will download, for the "Load summarizer (N MB)" label (rule 11). */
  sizeMb(): number {
    return Math.round(this.tier().files.reduce((a, f) => a + f.bytes, 0) / 1e6);
  }

  /** How many model files have been requested from the Hub so far (0 until the first summary request). */
  requests(): number {
    return this.modelRequests;
  }

  stats(): RunStats {
    return { ...this.runStats, per_chunk_kept: [...this.runStats.per_chunk_kept] };
  }

  noticesSeen(): NoticeOut[] {
    return [...this.notices];
  }

  private notice(n: NoticeOut): void {
    this.notices.push(n);
    this.onNotice?.(n);
    this.runOpts?.onNotice?.(n);
  }

  /** Stage one: adapter + device only. Milliseconds; downloads nothing. */
  async probe(): Promise<GpuProbe> {
    if (this.gpu) return this.gpu;
    this.state = "probing";
    this.gpu = await probeWebGpu(this.flags.inject);
    if (this.flags.llm === "fake") this.gpu = { ...this.gpu, ok: true, reason: "ok" };
    if (!this.gpu.ok) {
      this.state = "failed";
      this.error = `webgpu:${this.gpu.reason}`;
      this.notice({ key: "notice.no_webgpu" });
    } else {
      this.state = "idle";
    }
    return this.gpu;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker =
      this.flags.llm === "fake"
        ? new Worker(new URL("../workers/llm.fake.worker.ts", import.meta.url), { type: "module" })
        : new Worker(new URL("../workers/llm.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e) => {
      this.state = "failed";
      this.error = `worker:${e.message}`;
      this.pending?.reject(new Error(this.error));
      this.pending = null;
      for (const w of this.waiters.values()) w.reject(new Error(this.error));
      this.waiters.clear();
    };
    return this.worker;
  }

  private post(m: MainToWorker): void {
    this.ensureWorker().postMessage(m);
  }

  private waitFor(type: WorkerToMain["type"], runId: number): Promise<WorkerToMain> {
    return new Promise((resolve, reject) => this.waiters.set(`${type}:${runId}`, { resolve, reject }));
  }

  private onWorkerMessage(m: WorkerToMain): void {
    if (m.type === "aborted") {
      // The Stop confirmation settles the drain even if a later load already bumped runId.
      const w = this.waiters.get(`aborted:${m.runId}`);
      if (w) {
        this.waiters.delete(`aborted:${m.runId}`);
        w.resolve(m);
      }
    }
    if (m.runId !== this.runId) return; // stale run: dropped (Cancellation)
    if (m.type === "progress") {
      if (m.status === "initiate") this.modelRequests++;
      if (m.status === "progress" || m.status === "download") {
        this.lastProgress = { file: m.file, loaded: m.loaded, total: m.total };
        this.onProgress?.(this.lastProgress);
      }
      return;
    }
    if (m.type === "token") {
      if (this.pending && this.pending.chunkIndex === m.chunkIndex) this.pending.onToken(m.text);
      return;
    }
    if (m.type === "chunk_done") {
      const p = this.pending;
      if (p && p.chunkIndex === m.chunkIndex) {
        this.pending = null;
        p.resolve({ tokens: m.tokens, ms: m.ms, aborted: false });
      }
      return;
    }
    if (m.type === "aborted") {
      const p = this.pending;
      this.pending = null;
      p?.resolve({ tokens: 0, ms: 0, aborted: true });
      return;
    }
    if (m.type === "error") {
      const err = new Error(`${m.name}: ${m.message}`);
      const p = this.pending;
      this.pending = null;
      p?.reject(err);
      for (const [k, w] of this.waiters) {
        if (k.endsWith(`:${m.runId}`)) {
          this.waiters.delete(k);
          w.reject(err);
        }
      }
      return;
    }
    const w = this.waiters.get(`${m.type}:${m.runId}`);
    if (w) {
      this.waiters.delete(`${m.type}:${m.runId}`);
      w.resolve(m);
    }
  }

  /**
   * Stage two: download on demand (rule 11: only from a summary request or the explicit button),
   * then a 1-token probe. Failure → state "failed" and a notice; Read all is unaffected.
   */
  async ensureLoaded(opts: { signal?: AbortSignal } = {}): Promise<boolean> {
    if (this.loaded) return true;
    // An explicit load right after a Stop waits for the worker to finish unwinding (Codex review, PR #16).
    if (this.drain) await this.drain;
    if (opts.signal?.aborted) return false;
    if (this.loading) {
      // A second caller joins the load already running; its signal can still stop it.
      const abort = () => this.abort();
      opts.signal?.addEventListener("abort", abort, { once: true });
      try {
        return await this.loading;
      } finally {
        opts.signal?.removeEventListener("abort", abort);
      }
    }
    const p = this.loadOnce(opts);
    this.loading = p;
    try {
      return await p;
    } finally {
      if (this.loading === p) this.loading = null;
    }
  }

  private async loadOnce(opts: { signal?: AbortSignal }): Promise<boolean> {
    this.stopDuringProbe = false;
    const gpu = await this.probe();
    if (!gpu.ok) return false;
    if (opts.signal?.aborted || this.stopDuringProbe) {
      this.stopDuringProbe = false;
      // Stopped while the adapter probe was running, before the abort listener existed.
      this.state = "stopped";
      this.error = "aborted";
      this.notice({ key: "notice.stopped" });
      return false;
    }
    this.state = "loading";
    const runId = ++this.runId;
    const spec = this.tier();
    this.modelSpec = spec;
    const abort = () => this.abort();
    opts.signal?.addEventListener("abort", abort, { once: true });
    try {
      const t0 = performance.now();
      const loadedP = this.waitFor("loaded", runId);
      this.post({ type: "load", runId, model: spec, inject: this.flags.inject });
      const loaded = (await loadedP) as Extract<WorkerToMain, { type: "loaded" }>;
      this.runStats.model_id = loaded.modelId;
      this.runStats.role = loaded.role;
      this.runStats.downgraded = loaded.downgraded;
      this.runStats.load_ms = Math.round(performance.now() - t0);
      if (loaded.downgraded) this.notice({ key: "notice.low_end_tier" });
      const probeP = this.waitFor("probe_result", runId);
      this.post({ type: "probe", runId });
      const probe = (await probeP) as Extract<WorkerToMain, { type: "probe_result" }>;
      this.runStats.probe_ms = probe.ms;
      if (!probe.ok) {
        this.state = "failed";
        this.error = `probe:${probe.error ?? "failed"}`;
        this.notice({ key: "notice.probe_failed" });
        return false;
      }
      this.loaded = true;
      this.state = "idle";
      return true;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        this.state = "stopped";
        this.error = "aborted";
        this.notice({ key: "notice.stopped" });
        return false;
      }
      this.state = "failed";
      this.error = e instanceof Error ? e.message : String(e);
      this.notice({ key: this.error.startsWith("OutOfMemory") ? "notice.probe_failed" : "error.model_download" });
      return false;
    } finally {
      opts.signal?.removeEventListener("abort", abort);
    }
  }

  /** Read through a method so TypeScript does not narrow `state` across awaits. */
  private stopped(): boolean {
    return this.state === "stopped";
  }

  private countTokens = (text: string): Promise<number> | number =>
    this.flags.llm === "fake" ? Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3) : countTokens(text, this.activeTier());

  /** The tier the worker actually loaded (a memory fallback may have replaced the requested one). */
  private activeTier(): PinnedModel & { role: string } {
    return summarizerTiers().find((t) => t.role === this.runStats.role) ?? this.modelSpec ?? this.tier();
  }

  private levelCfg(level: Level): Required<Pick<DialLevel, "max_bullets_per_chunk" | "max_words_per_bullet" | "max_new_tokens">> & DialLevel {
    const l = LEVELS.get(level);
    if (!l || !l.prompt) throw new Error(`unknown level ${level}`);
    return { max_bullets_per_chunk: 6, max_words_per_bullet: 18, max_new_tokens: 220, ...l } as Required<
      Pick<DialLevel, "max_bullets_per_chunk" | "max_words_per_bullet" | "max_new_tokens">
    > &
      DialLevel;
  }

  private generate(runId: number, chunkIndex: number, user: string, level: Level, text: string, maxNewTokens: number, onToken: (t: string) => void) {
    return new Promise<{ tokens: number; ms: number; aborted: boolean }>((resolve, reject) => {
      this.pending = { runId, chunkIndex, onToken, resolve, reject };
      const msg: GenerateMsg = { type: "generate", runId, chunkIndex, user, maxNewTokens };
      if (this.flags.prompt === "system") msg.system = SYSTEM_VARIANT;
      if (this.flags.llm === "fake") msg.fake = { key: this.flags.fake, level, text, delay_ms: this.flags.delay_ms };
      this.post(msg);
    });
  }

  /** Stop the current run: abort the worker, drop everything still queued. */
  abort(): void {
    if (this.state === "probing") {
      // Nothing is on the worker yet; loadOnce() sees this once the probe returns (Codex review, PR #16).
      this.stopDuringProbe = true;
      return;
    }
    if (this.state !== "running" && this.state !== "loading") return;
    const runId = this.runId;
    this.state = "stopped";
    this.post({ type: "abort", runId });
    this.pending?.resolve({ tokens: 0, ms: 0, aborted: true });
    this.pending = null;
    // A Stop during the download must settle ensureLoaded()'s waiters too (Codex review, PR #16).
    const err = new Error("aborted");
    err.name = "AbortError";
    for (const [k, w] of this.waiters) {
      if (k.endsWith(`:${runId}`) && !k.startsWith("aborted:")) {
        this.waiters.delete(k);
        w.reject(err);
      }
    }
    this.armDrain(runId);
  }

  /**
   * Stop resolves the UI at once, but the worker may still be finishing an interrupted
   * generate. The next run waits for the worker's "aborted" before it posts anything. If
   * that takes longer than ABORT_DRAIN_MS the worker is replaced, so a stuck GPU job can
   * never run under the next summary (Codex review, PR #16).
   */
  private armDrain(runId: number): void {
    const key = `aborted:${runId}`;
    const confirmed = this.waitFor("aborted", runId).then(
      () => undefined,
      () => undefined,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<void>((r) => {
      timer = setTimeout(() => {
        this.waiters.delete(key);
        this.resetWorker();
        r();
      }, ABORT_DRAIN_MS);
    });
    const d: Promise<void> = Promise.race([confirmed, capped]).then(() => {
      clearTimeout(timer);
      if (this.drain === d) this.drain = null;
    });
    this.drain = d;
  }

  /** Drop a worker that never confirmed a Stop; the next run starts a fresh one and reloads from cache. */
  private resetWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.loaded = false;
    this.pending = null;
    this.waiters.clear();
  }

  private inFlight: Promise<RunStats> | null = null;

  /** Runs are serialized: a second call waits for the previous one to settle (Codex review, PR #16). */
  summarize(text: string, level: Level, opts: SummarizeOptions = {}): Promise<RunStats> {
    const prev = this.inFlight ?? Promise.resolve();
    const start = () => (this.drain ?? Promise.resolve()).then(() => this.summarizeNow(text, level, opts));
    const run = prev.then(start, start);
    this.inFlight = run;
    run.then(
      () => {
        if (this.inFlight === run) this.inFlight = null;
      },
      () => {
        if (this.inFlight === run) this.inFlight = null;
      },
    );
    return run;
  }

  private async summarizeNow(text: string, level: Level, opts: SummarizeOptions = {}): Promise<RunStats> {
    this.runOpts = opts;
    try {
      return await this.summarizeRun(text, level, opts);
    } finally {
      if (this.runOpts === opts) this.runOpts = null;
    }
  }

  private async summarizeRun(text: string, level: Level, opts: SummarizeOptions): Promise<RunStats> {
    if (opts.signal?.aborted) {
      // Cancelled while queued behind another run: never start it (Codex review, PR #16).
      const prev = this.runStats;
      this.runStats = { ...emptyStats(), model_id: prev.model_id, role: prev.role, downgraded: prev.downgraded, load_ms: prev.load_ms, probe_ms: prev.probe_ms, level };
      this.state = "stopped";
      this.error = "aborted";
      return this.stats();
    }
    if (!(await this.ensureLoaded({ signal: opts.signal }))) return this.stats();
    const runId = ++this.runId;
    const started = performance.now();
    const prev = this.runStats;
    this.runStats = { ...emptyStats(), model_id: prev.model_id, role: prev.role, downgraded: prev.downgraded, load_ms: prev.load_ms, probe_ms: prev.probe_ms, level };
    this.state = "running";
    this.error = null;
    const abort = () => this.abort();
    opts.signal?.addEventListener("abort", abort, { once: true });
    try {
      const budget = { ...BUDGET, chunk_input_tokens: this.flags.chunk ?? BUDGET.chunk_input_tokens };
      let chunks: Chunk[];
      try {
        chunks = await chunkSentences(segmentSentences(text), this.countTokens, budget);
      } catch (e) {
        if (e instanceof InputLimitError) {
          this.notice({ key: "notice.input_limit" });
          this.state = "failed";
          this.error = "input_limit";
          return this.stats();
        }
        throw e;
      }
      this.runStats.chunks = chunks.length;
      const emit = (b: BulletOut) => {
        if (this.runStats.ttfa_ms === null) this.runStats.ttfa_ms = Math.round(performance.now() - started);
        opts.onBullet?.(b);
      };
      let ok: boolean;
      if (level === "oneline") ok = await this.oneLine(runId, chunks, emit, opts);
      else ok = await this.perChunk(runId, chunks, level, emit, opts);
      if (this.stopped()) return this.stats();
      if (ok) {
        this.runStats.tok_s = this.runStats.gen_ms > 0 ? Math.round((this.runStats.tokens / (this.runStats.gen_ms / 1000)) * 10) / 10 : null;
        this.state = "done";
      }
      return this.stats();
    } catch (e) {
      if (this.stopped()) return this.stats();
      this.state = "failed";
      this.error = e instanceof Error ? e.message : String(e);
      this.notice({ key: "error.generation" });
      return this.stats();
    } finally {
      opts.signal?.removeEventListener("abort", abort);
    }
  }

  /** Short / Caveman: every chunk gets its bullets; each bullet is grounded against its own chunk. */
  private async perChunk(runId: number, chunks: Chunk[], level: Level, emit: (b: BulletOut) => void, opts: SummarizeOptions): Promise<boolean> {
    const cfg = this.levelCfg(level);
    const prompt = PROMPTS[cfg.prompt!];
    this.runStats.level_used = level;
    for (const chunk of chunks) {
      if (runId !== this.runId || this.state === "stopped") return false;
      const parser = new BulletParser({ max_bullets_per_chunk: cfg.max_bullets_per_chunk, max_words_per_bullet: cfg.max_words_per_bullet });
      let kept = 0;
      const handle = (b: { text: string; index: number }) => {
        this.runStats.bullets_total++;
        const g = ground(b.text, chunk.text, COMMON_WORDS);
        if (g.ok) {
          kept++;
          emit({ text: b.text, chunkIndex: chunk.index, index: b.index, start: chunk.start, end: chunk.end });
        } else {
          this.runStats.bullets_cut++;
        }
      };
      const r = await this.generate(runId, chunk.index, prompt.replace("{{text}}", () => chunk.text), level, chunk.text, cfg.max_new_tokens, (t) => {
        opts.onToken?.(t);
        for (const b of parser.push(t)) handle(b);
      });
      if (r.aborted) return false;
      for (const b of parser.flush()) handle(b);
      this.runStats.parser_dropped += parser.dropped;
      this.runStats.parser_overlength += parser.overlength;
      this.runStats.tokens += r.tokens;
      this.runStats.gen_ms += r.ms;
      this.runStats.per_chunk_kept.push(kept);
      // Nothing kept, whether every bullet was cut or the model gave none: say so (grounding.md).
      if (kept === 0) {
        this.runStats.all_cut_chunks++;
        this.notice({ key: "notice.all_cut", chunkIndex: chunk.index, start: chunk.start, end: chunk.end });
      }
    }
    return true;
  }

  /**
   * One line (spec/chunking.md "One-line policy"): a one-liner per chunk, grounded against its
   * chunk; cut lines contribute nothing; survivors reduced in groups ≤ group_size, depth ≤
   * max_depth, each reduced line grounded against the lines it came from; > max_cut_fraction cut
   * → Short with notice.oneline_failed. Only the final line is emitted (and spoken).
   */
  private async oneLine(runId: number, chunks: Chunk[], emit: (b: BulletOut) => void, opts: SummarizeOptions): Promise<boolean> {
    const cfg = this.levelCfg("oneline");
    const reduce = cfg.reduce ?? { group_size: 10, max_depth: 2, fallback_level: "short", max_cut_fraction: 0.5 };
    const prompt = PROMPTS[cfg.prompt!];
    this.runStats.level_used = "oneline";
    const survivors: string[] = [];
    let cut = 0;
    for (const chunk of chunks) {
      if (runId !== this.runId || this.state === "stopped") return false;
      const parser = new BulletParser({ max_bullets_per_chunk: 1, max_words_per_bullet: cfg.max_words_per_bullet });
      const lines: string[] = [];
      const r = await this.generate(runId, chunk.index, prompt.replace("{{text}}", () => chunk.text), "oneline", chunk.text, cfg.max_new_tokens, (t) => {
        opts.onToken?.(t);
        for (const b of parser.push(t)) lines.push(b.text);
      });
      if (r.aborted) return false;
      for (const b of parser.flush()) lines.push(b.text);
      this.runStats.parser_dropped += parser.dropped;
      this.runStats.parser_overlength += parser.overlength;
      this.runStats.tokens += r.tokens;
      this.runStats.gen_ms += r.ms;
      this.runStats.bullets_total += lines.length;
      const line = lines[0];
      if (line && ground(line, chunk.text, COMMON_WORDS).ok) {
        survivors.push(line);
        this.runStats.per_chunk_kept.push(1);
      } else {
        cut++;
        this.runStats.bullets_cut += line ? 1 : 0;
        this.runStats.per_chunk_kept.push(0);
      }
    }
    const fallback = async () => {
      this.notice({ key: "notice.oneline_failed" });
      this.runStats.per_chunk_kept = [];
      return this.perChunk(runId, chunks, reduce.fallback_level as Level, emit, opts);
    };
    if (chunks.length === 0 || cut / chunks.length > reduce.max_cut_fraction || survivors.length === 0) return fallback();
    let lines = survivors;
    let depth = 0;
    while (lines.length > 1 && depth < reduce.max_depth) {
      depth++;
      const next: string[] = [];
      for (let i = 0; i < lines.length; i += reduce.group_size) {
        if (runId !== this.runId || this.state === "stopped") return false;
        const group = lines.slice(i, i + reduce.group_size);
        const source = group.map((l) => `- ${l}`).join("\n");
        const parser = new BulletParser({ max_bullets_per_chunk: 1, max_words_per_bullet: cfg.max_words_per_bullet });
        const out: string[] = [];
        this.runStats.reduce_calls++;
        const r = await this.generate(runId, 1000 + depth * 100 + i, PROMPTS["prompts/reduce-oneline.md"].replace("{{lines}}", () => source), "oneline", source, cfg.max_new_tokens, (t) => {
          opts.onToken?.(t);
          for (const b of parser.push(t)) out.push(b.text);
        });
        if (r.aborted) return false;
        for (const b of parser.flush()) out.push(b.text);
        this.runStats.parser_dropped += parser.dropped;
        this.runStats.parser_overlength += parser.overlength;
        this.runStats.tokens += r.tokens;
        this.runStats.gen_ms += r.ms;
        // Same accounting as the per-chunk lines above: a reduce output counts toward the total,
        // and only a line that was produced and then failed grounding counts as cut (Codex review, PR #16).
        this.runStats.bullets_total += out.length;
        const line = out[0];
        if (line && ground(line, source, COMMON_WORDS).ok) next.push(line);
        else if (line) this.runStats.bullets_cut++;
      }
      if (next.length === 0) return fallback();
      lines = next;
    }
    const final = lines[0];
    emit({ text: final, chunkIndex: -1, index: 0, start: chunks[0].start, end: chunks[chunks.length - 1].end });
    return true;
  }
}
