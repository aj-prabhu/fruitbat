// S1-10 proof (docs/PLAN.md): the stats store never persists anything outside the strict RunStats
// schema, retention evicts the oldest row past 200, and a storage failure (QuotaExceededError or
// otherwise) never throws out of record(). Plain Node (no DOM needed): localStorage/navigator are
// stubbed globals, same technique net.test.ts uses for `fetch`.
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorStats } from "../engine/orchestrator";
import type { RunStats as GenStats } from "../engine/llm";
import type { RunStatsRow, StreamMetrics } from "../engine/tts";
import { CSV_FIELDS, validateRunStats } from "../stats/schema";
import { ERRORS_KEY, RETENTION, STORAGE_KEY, buildRow, clear, errorCount, exportCsv, record, rows, setDocId, type StatsEnv } from "../stats/store";

const BENCH_EXAMPLE_ROW = new URL("../../../bench/example-row.json", import.meta.url);
const BENCH_RESULTS_CSV = new URL("../../../bench/results.csv", import.meta.url);

// ---------------------------------------------------------------- fake localStorage
function makeFakeLocalStorage(blockedKey: string) {
  const store = new Map<string, string>();
  let blocked = false;
  const api: Storage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      if (blocked && k === blockedKey) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  return {
    api,
    dump: () => Object.fromEntries(store),
    block: (v: boolean) => {
      blocked = v;
    },
  };
}

let fake: ReturnType<typeof makeFakeLocalStorage>;

beforeEach(() => {
  fake = makeFakeLocalStorage(STORAGE_KEY);
  vi.stubGlobal("localStorage", fake.api);
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------- fixtures
const VALID_ENV: StatsEnv = {
  browser: "chrome",
  browser_major: 130,
  os: "macos",
  os_major: 15,
  machine_id: "web",
  commit: "81092b9",
  date: "2026-09-25T12:00:00.000Z",
  doc_id: "paste",
};

const GEN_FIXTURE: GenStats = {
  cache_cold: false,
  level: "short",
  level_used: "short",
  chunks: 2,
  bullets_total: 5,
  bullets_cut: 0,
  all_cut_chunks: 0,
  parser_dropped: 0,
  parser_overlength: 0,
  reduce_calls: 0,
  ttfa_ms: 1200,
  gen_ms: 3100,
  tokens: 180,
  tok_s: 22.5,
  model_id: "onnx-community/Qwen3.5-0.8B-Text-ONNX",
  role: "default",
  downgraded: false,
  load_ms: 900,
  probe_ms: 40,
  per_chunk_kept: [3, 2],
};

const SHORT_VOICE_RUN: StreamMetrics = {
  cache_state: "warm",
  ttfa_ms: 1200,
  rtf: 1.4,
  gap_ms: 90,
  seconds: 12.3,
  synth_ms: 3100,
  tts_overlimit: 0,
  device: "wasm",
  dtype: "q8",
};

/** A finished Short run (docs/PLAN.md Architecture "Concurrency model" / S1-06 OrchestratorStats). */
const SHORT_STATS: OrchestratorStats = {
  runs: 1,
  last: { level: "short", chars: 1000 },
  ttfa_ms: 1200,
  stop_ms: null,
  notice_latency_ms: null,
  notices_spoken: [],
  gen: GEN_FIXTURE,
  voice: null,
  voice_run: SHORT_VOICE_RUN,
};

const READALL_VOICE_ROW: RunStatsRow = {
  schema_version: 1,
  target: "web",
  device: "wasm",
  level: "readall",
  browser: "chrome",
  browser_major: 130,
  os: "macos",
  os_major: 15,
  cache_state: "warm",
  model_id: "onnx-community/Kokoro-82M-v1.0-ONNX",
  model_rev: "1939ad2a8e416c0acfeecc08a694d14ef25f2231",
  dtype: "q8",
  doc_id: null,
  commit: null,
  date: "2026-09-25T00:00:00.000Z",
  machine_id: "web",
  ttfa_ms: 300,
  gen_ms: null,
  tok_s: null,
  rtf: 3.2,
  gap_ms: 20,
  stop_ms: null,
  coverage: 1,
  bullets_total: null,
  bullets_cut: null,
  cut_rate: null,
  facts_token_hit: null,
  halluc_flags: null,
  forbidden_hits: null,
  oneline_keyword_hit: null,
  tts_overlimit: 0,
  peak_mb: null,
  heap_mb: 280,
};

/** A finished Read all run: no LLM at all (Architecture: "readall has no LLM metrics"). */
const READALL_STATS: OrchestratorStats = {
  runs: 1,
  last: { level: "readall", chars: 500 },
  ttfa_ms: 300,
  stop_ms: 140,
  notice_latency_ms: null,
  notices_spoken: [],
  gen: null,
  voice: READALL_VOICE_ROW,
  voice_run: { cache_state: "warm", ttfa_ms: 300, rtf: 3.2, gap_ms: 20, seconds: 8.5, synth_ms: 2600, tts_overlimit: 0, device: "wasm", dtype: "q8" },
};

// ---------------------------------------------------------------- schema validation
describe("validateRunStats", () => {
  const exampleRow = JSON.parse(readFileSync(BENCH_EXAMPLE_ROW, "utf8")) as Record<string, unknown>;

  it("accepts bench's own example RunStats row", () => {
    const { ok, errors } = validateRunStats(exampleRow);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it("rejects a row with a field outside the schema", () => {
    const bad = { ...exampleRow, note: "not part of RunStats" };
    const { ok, errors } = validateRunStats(bad);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("note"))).toBe(true);
  });

  it("rejects a string field outside its enum", () => {
    const { ok } = validateRunStats({ ...exampleRow, browser: "opera" });
    expect(ok).toBe(false);
  });

  it("rejects a string field that fails its pattern", () => {
    const { ok } = validateRunStats({ ...exampleRow, commit: "not-hex!" });
    expect(ok).toBe(false);
  });

  it("rejects a missing required field", () => {
    const bad = { ...exampleRow };
    delete bad.ttfa_ms;
    const { ok, errors } = validateRunStats(bad);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("ttfa_ms"))).toBe(true);
  });

  it("accepts null for a nullable metric", () => {
    const { ok, errors } = validateRunStats({ ...exampleRow, oneline_keyword_hit: null });
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });
});

// ---------------------------------------------------------------- buildRow
describe("buildRow", () => {
  it("assembles a valid row from a real Short-run OrchestratorStats fixture", () => {
    const row = buildRow(SHORT_STATS, VALID_ENV);
    const { ok, errors } = validateRunStats(row);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(row.level).toBe("short");
    expect(row.doc_id).toBe("paste");
    // dumped for the manual cross-check against the independent Python validator
    // (docs/PLAN.md S1-10 Proof: `python3 bench/schema_check.py <row> spec/schemas/run-stats.schema.json`)
    writeFileSync("/tmp/fruitbat-run-stats-row.json", JSON.stringify(row, null, 2));
  });

  it("assembles a valid row from a real Read-all-run OrchestratorStats fixture (no LLM metrics)", () => {
    const row = buildRow(READALL_STATS, VALID_ENV);
    const { ok, errors } = validateRunStats(row);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(row.level).toBe("readall");
    expect(row.gen_ms).toBeNull();
    expect(row.coverage).toBe(1);
  });

  it("cache_state is cold only for the run that fetched a model over the network (Codex review, PR #27)", () => {
    expect(buildRow(SHORT_STATS, VALID_ENV).cache_state).toBe("warm");
    expect(buildRow({ ...SHORT_STATS, gen: { ...GEN_FIXTURE, cache_cold: true } }, VALID_ENV).cache_state).toBe("cold");
    expect(buildRow({ ...SHORT_STATS, voice_run: { ...SHORT_VOICE_RUN, cache_state: "cold" } }, VALID_ENV).cache_state).toBe("cold");
    expect(buildRow(READALL_STATS, VALID_ENV).cache_state).toBe("warm");
    // a Read-all row ignores a stale summarizer flag
    expect(buildRow({ ...READALL_STATS, gen: { ...GEN_FIXTURE, cache_cold: true } }, VALID_ENV).cache_state).toBe("warm");
  });

  it("a Read-all row from the WebGPU voice (q8f16) validates (Codex review, PR #22)", () => {
    const row = buildRow({ ...READALL_STATS, voice_run: { ...READALL_STATS.voice_run!, device: "webgpu", dtype: "q8f16" } }, VALID_ENV);
    expect(row.dtype).toBe("q8f16");
    expect(validateRunStats(row).errors).toEqual([]);
  });

  it("never copies an arbitrary field off the orchestrator stats object", () => {
    const tainted = { ...SHORT_STATS, gen: { ...GEN_FIXTURE, note: "source snippet: CANARY-7f3a" } } as unknown as OrchestratorStats;
    const row = buildRow(tainted, VALID_ENV);
    expect(JSON.stringify(row)).not.toContain("CANARY");
  });
});

// ---------------------------------------------------------------- record / storage
describe("record", () => {
  it("persists a valid row and it comes back from rows()", () => {
    const result = record(SHORT_STATS, VALID_ENV);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].level).toBe("short");
  });

  it("a run whose data carries a CANARY-7f3a marker leaves no CANARY in storage", () => {
    const tainted = { ...SHORT_STATS, gen: { ...GEN_FIXTURE, note: "source snippet: CANARY-7f3a" } } as unknown as OrchestratorStats;
    const result = record(tainted, VALID_ENV);
    expect(result.ok).toBe(true); // buildRow never copied the rogue field, so the row is still valid
    expect(JSON.stringify(fake.dump())).not.toContain("CANARY");
  });

  it("uses setDocId's value until it's set again", () => {
    setDocId("011");
    const row = buildRow(SHORT_STATS, { ...VALID_ENV, doc_id: "011" });
    expect(row.doc_id).toBe("011");
    setDocId("paste"); // leave global module state clean for later tests
  });

  it("the 201st row evicts the oldest", () => {
    for (let i = 0; i < RETENTION + 1; i++) {
      const env: StatsEnv = { ...VALID_ENV, commit: String(i).padStart(7, "0") };
      const result = record(SHORT_STATS, env);
      expect(result.ok).toBe(true);
    }
    const stored = rows();
    expect(stored).toHaveLength(RETENTION);
    expect(stored[0].commit).toBe(String(1).padStart(7, "0")); // row 0 evicted
    expect(stored[stored.length - 1].commit).toBe(String(RETENTION).padStart(7, "0"));
  });

  it("a stubbed QuotaExceededError from setItem does not throw out of record(), and is counted", () => {
    fake.block(true);
    expect(() => record(SHORT_STATS, VALID_ENV)).not.toThrow();
    const result = record(SHORT_STATS, VALID_ENV);
    expect(result.ok).toBe(true); // the row itself is valid; only persistence failed
    expect(rows()).toHaveLength(0); // nothing made it into storage
    expect(errorCount()).toBeGreaterThanOrEqual(1);
    fake.block(false);
  });

  it("clear() empties both the rows and the error counter", () => {
    record(SHORT_STATS, VALID_ENV);
    fake.block(true);
    record(SHORT_STATS, VALID_ENV);
    fake.block(false);
    expect(rows().length).toBeGreaterThan(0);
    expect(errorCount()).toBeGreaterThan(0);
    clear();
    expect(rows()).toEqual([]);
    expect(errorCount()).toBe(0);
  });
});

// ---------------------------------------------------------------- exportCsv
describe("exportCsv", () => {
  it("header equals bench/results.csv's header", () => {
    const benchHeader = readFileSync(BENCH_RESULTS_CSV, "utf8").split("\n")[0].trim();
    const ourHeader = exportCsv().split("\n")[0];
    expect(ourHeader).toBe(benchHeader);
    expect(CSV_FIELDS.join(",")).toBe(benchHeader);
  });

  it("carries every stored row, in schema field order", () => {
    record(SHORT_STATS, VALID_ENV);
    const csv = exportCsv();
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2); // header + 1 row
    expect(lines[1].split(",")[CSV_FIELDS.indexOf("level")]).toBe("short");
  });
});
