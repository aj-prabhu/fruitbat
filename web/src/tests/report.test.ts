// S1-11 proof (docs/PLAN.md): the BugReport envelope never leaks anything the user was reading,
// its GitHub issue-form URL trims oldest events then oldest rows to stay <= 8,000 chars, a
// description never touches storage, and the envelope validates against
// spec/schemas/bug-report.schema.json. Plain Node (no DOM needed): navigator/localStorage are
// stubbed globals, same technique stats.test.ts uses.
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "../engine/events";
import type { RunStats as GenStats } from "../engine/llm";
import type { OrchestratorStats } from "../engine/orchestrator";
import { buildCopyText, buildIssueUrl, buildReport, osString, validateBugReport } from "../report/build";
import { validateAgainst } from "../stats/validate";
import type { StatsRow } from "../stats/store";

const BENCH_EXAMPLE_ROW = new URL("../../../bench/example-row.json", import.meta.url);
const EXAMPLE_ROW = JSON.parse(readFileSync(BENCH_EXAMPLE_ROW, "utf8")) as StatsRow;

function row(doc_id: string): StatsRow {
  return { ...EXAMPLE_ROW, doc_id };
}

function ev(i: number): Event {
  return { event: "dial_change", t_ms: i, fields: { chunk_index: i } };
}

beforeEach(() => {
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    platform: "MacIntel",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------- fixtures
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
  voice_run: null,
};

// ---------------------------------------------------------------- buildReport
describe("validateAgainst", () => {
  it("an undefined or non-finite value never passes as an object (Codex review, PR #23)", () => {
    const row = JSON.parse(readFileSync(new URL("../../../bench/example-row.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(validateAgainst("run-stats.schema.json", row).ok).toBe(true);
    expect(validateAgainst("run-stats.schema.json", { ...row, ttfa_ms: undefined }).ok).toBe(false);
    expect(validateAgainst("run-stats.schema.json", { ...row, ttfa_ms: Number.NaN }).ok).toBe(false);
  });
});

describe("osString", () => {
  it("reads iOS before macOS: iPhone and iPad user agents say 'like Mac OS X' (Codex review, PR #23)", () => {
    expect(osString("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15")).toBe("ios 18");
    expect(osString("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")).toBe("macos 10");
  });
});

describe("buildReport", () => {
  it("assembles an envelope that validates against bug-report.schema.json", async () => {
    const report = await buildReport({
      orchestratorStats: SHORT_STATS,
      rows: [row("011")],
      events: [ev(0), ev(1)],
      description: "it crashed",
    });
    const { ok, errors } = validateBugReport(report);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(report.app).toBe("web");
    expect(report.user_description).toBe("it crashed");
    // dumped for the manual cross-check against the independent Python validator
    // (docs/PLAN.md S1-11 Proof: `python3 bench/schema_check.py <report> spec/schemas/bug-report.schema.json`)
    writeFileSync("/tmp/report.json", JSON.stringify(report, null, 2));
  });

  it("keeps only the newest <= 5 run_stats rows and <= 50 events", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(String(i).padStart(3, "0")));
    const events = Array.from({ length: 60 }, (_, i) => ev(i));
    const report = await buildReport({ orchestratorStats: SHORT_STATS, rows, events, description: "" });
    expect(report.run_stats).toHaveLength(5);
    expect(report.run_stats.map((r) => r.doc_id)).toEqual(["003", "004", "005", "006", "007"]);
    expect(report.events).toHaveLength(50);
    expect(report.events[0].fields.chunk_index).toBe(10);
    expect(report.events[49].fields.chunk_index).toBe(59);
  });

  it("caps user_description at 2000 chars", async () => {
    const report = await buildReport({ orchestratorStats: SHORT_STATS, rows: [], events: [], description: "x".repeat(3000) });
    expect(report.user_description).toHaveLength(2000);
  });

  it("a CANARY marker on the orchestrator stats' gen object never reaches any field", async () => {
    const tainted = { ...SHORT_STATS, gen: { ...GEN_FIXTURE, note: "source snippet: CANARY-7f3a" } } as unknown as OrchestratorStats;
    const report = await buildReport({ orchestratorStats: tainted, rows: [row("011")], events: [], description: "" });
    expect(JSON.stringify(report)).not.toContain("CANARY");
  });

  it("a CANARY marker smuggled onto a stats-store row never reaches the report", async () => {
    const taintedRow = { ...row("011"), note: "source snippet: CANARY-7f3a" } as unknown as StatsRow;
    const report = await buildReport({ orchestratorStats: SHORT_STATS, rows: [taintedRow], events: [], description: "" });
    expect(JSON.stringify(report)).not.toContain("CANARY");
    expect(validateBugReport(report).ok).toBe(true); // the sanitized row still validates in full
  });

  it("a CANARY marker smuggled onto an event's fields never reaches the report", async () => {
    const taintedEvent = { event: "dial_change", t_ms: 1, fields: { chunk_index: 1, note: "CANARY-7f3a" } } as unknown as Event;
    const report = await buildReport({ orchestratorStats: SHORT_STATS, rows: [], events: [taintedEvent], description: "" });
    expect(JSON.stringify(report)).not.toContain("CANARY");
  });

  it("never touches localStorage, even when building a report with a description", async () => {
    const store = new Map<string, string>();
    const fakeStorage: Storage = {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => {
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
    vi.stubGlobal("localStorage", fakeStorage);
    const before = JSON.stringify(Object.fromEntries(store));
    await buildReport({ orchestratorStats: SHORT_STATS, rows: [row("011")], events: [ev(0)], description: "a description" });
    const after = JSON.stringify(Object.fromEntries(store));
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------- buildIssueUrl
describe("buildIssueUrl", () => {
  it("targets the repo's bug.yml template with every one of its field ids", async () => {
    const report = await buildReport({ orchestratorStats: SHORT_STATS, rows: [row("011")], events: [ev(0)], description: "it crashed" });
    const url = buildIssueUrl(report);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://github.com/aj-prabhu/fruitbat/issues/new");
    expect(parsed.searchParams.get("template")).toBe("bug.yml");
    for (const id of ["what_happened", "env", "models", "run_stats", "events", "app_version", "title"]) {
      expect(parsed.searchParams.has(id)).toBe(true);
    }
  });

  it("carries the user's own description but nothing else that was tainted with a CANARY marker", async () => {
    const taintedEvent = { event: "dial_change", t_ms: 1, fields: { chunk_index: 1, note: "CANARY-7f3a" } } as unknown as Event;
    const taintedRow = { ...row("011"), note: "CANARY-7f3a" } as unknown as StatsRow;
    const report = await buildReport({
      orchestratorStats: SHORT_STATS,
      rows: [taintedRow],
      events: [taintedEvent],
      description: "CANARY-7f3a is what I typed myself, on purpose",
    });
    const parsed = new URL(buildIssueUrl(report));
    expect(parsed.searchParams.get("what_happened")).toContain("CANARY"); // the user's own text: expected
    for (const id of ["env", "models", "run_stats", "events", "app_version", "title"]) {
      expect(parsed.searchParams.get(id) ?? "").not.toContain("CANARY");
    }
  });

  it("keeps the encoded URL <= 8000 chars, trimming oldest events first and then oldest rows", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(String(i).padStart(3, "0")));
    const events = Array.from({ length: 60 }, (_, i) => ev(i));
    const report = await buildReport({ orchestratorStats: SHORT_STATS, rows, events, description: "x".repeat(500) });
    expect(report.events).toHaveLength(50);
    expect(report.run_stats).toHaveLength(5);

    const url = buildIssueUrl(report);
    // eslint-disable-next-line no-console -- Proof requires this printed verbatim.
    console.log(`sample issue URL length: ${url.length}`);
    expect(url.length).toBeLessThanOrEqual(8000);

    const parsed = new URL(url);
    const survivingEvents = JSON.parse(parsed.searchParams.get("events") ?? "[]") as Event[];
    const survivingRows = JSON.parse(parsed.searchParams.get("run_stats") ?? "[]") as StatsRow[];

    // oldest-first trimming: whatever survives is the newest suffix of the report-level array.
    if (survivingEvents.length > 0 && survivingEvents.length < report.events.length) {
      const expectedFirst = report.events[report.events.length - survivingEvents.length];
      expect(survivingEvents[0].fields.chunk_index).toBe(expectedFirst.fields.chunk_index);
    }
    // rows are only ever trimmed once every event is already gone.
    if (survivingRows.length < report.run_stats.length) {
      expect(survivingEvents).toHaveLength(0);
    }
  });

  it("a small report's URL comfortably fits in one line", async () => {
    const report = await buildReport({ orchestratorStats: SHORT_STATS, rows: [row("011")], events: [ev(0)], description: "short bug" });
    const url = buildIssueUrl(report);
    console.log(`sample issue URL: ${url}`);
    console.log(`sample issue URL length: ${url.length}`);
    expect(url.length).toBeLessThanOrEqual(8000);
  });
});

// ---------------------------------------------------------------- buildCopyText
describe("buildCopyText", () => {
  it("is the full, untrimmed report as pretty JSON", async () => {
    const report = await buildReport({ orchestratorStats: SHORT_STATS, rows: [row("011")], events: [ev(0)], description: "it crashed" });
    const text = buildCopyText(report);
    expect(JSON.parse(text)).toEqual(report);
  });
});

// ---------------------------------------------------------------- validateBugReport
describe("validateBugReport", () => {
  it("rejects an envelope with a field outside the schema", async () => {
    const report = await buildReport({ orchestratorStats: SHORT_STATS, rows: [], events: [], description: "" });
    const bad = { ...report, extra: "nope" };
    const { ok, errors } = validateBugReport(bad);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("extra"))).toBe(true);
  });

  it("rejects a user_description over 2000 chars", async () => {
    const report = await buildReport({ orchestratorStats: SHORT_STATS, rows: [], events: [], description: "" });
    const bad = { ...report, user_description: "x".repeat(2001) };
    const { ok } = validateBugReport(bad);
    expect(ok).toBe(false);
  });
});
