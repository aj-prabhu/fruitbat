// The bug-report envelope (docs/PLAN.md S1-11, C7, C11, "Bug-report pipeline"). `buildReport`
// assembles a `BugReport` per spec/schemas/bug-report.schema.json; `buildIssueUrl` turns one into
// a prefilled GitHub issue-form URL (field params by id, per .github/ISSUE_TEMPLATE/bug.yml --
// PLAN-REVIEW-LOG.md round 1 #26: field ids, not `body=`, or GitHub's YAML form silently drops the
// prefill); `buildCopyText` is the clipboard fallback. Nothing here ever spreads an untyped object
// into the report (the same defense stats/store.ts's buildRow uses): every field is copied through
// a named accessor or an explicit allow-list, so a stray free-text property anywhere upstream
// (a bug, or a hostile fixture) can never reach a field, let alone the URL a user is about to open
// (Non-negotiable 1: never source text, bullets, audio, file names, or URLs of what they read).
import versionJson from "../../../spec/version.json";
import type { Event, EventFields } from "../engine/events";
import { EVENT_FIELD_KEYS } from "../engine/events";
import type { OrchestratorStats } from "../engine/orchestrator";
import { pinnedModels, summarizerTiers } from "../engine/pins";
import { CSV_FIELDS } from "../stats/schema";
import type { StatsRow } from "../stats/store";
import { validateBugReport, type ValidationResult } from "../stats/validate";

export interface BugReportEnv {
  ua: string;
  gpu: string;
  os: string;
  chip: string;
  ram_bucket: "under_8gb" | "8gb" | "16gb" | "32gb" | "64gb_plus" | "unknown";
}

export interface BugReportModel {
  id: string;
  rev: string;
}

export interface BugReport {
  app: "web" | "mac";
  version: string;
  env: BugReportEnv;
  models: BugReportModel[];
  run_stats: StatsRow[];
  events: Event[];
  user_description: string;
}

const MAX_RUN_STATS = 5;
const MAX_EVENTS = 50;
const MAX_DESCRIPTION = 2000;
/** GitHub's own issue-form field-param URLs comfortably support far more than this; the packet's
 *  own ceiling (docs/PLAN.md S1-11 v3) is the one enforced here. */
const MAX_URL_LENGTH = 8000;
const REPO_URL = "https://github.com/aj-prabhu/fruitbat";

// ---------------------------------------------------------------- env
const ENV_MAX = { ua: 300, gpu: 200, os: 100, chip: 50 } as const;

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Best-effort GPU description from the WebGPU adapter's own info (milliseconds, no download --
 *  the same stage-one probe budget as capabilities.ts's probeWebGpu). "unknown" whenever WebGPU,
 *  an adapter, or adapter.info isn't available, never a guess. */
async function probeGpu(): Promise<string> {
  try {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) return "unknown";
    const adapter = await gpu.requestAdapter();
    if (!adapter) return "unknown";
    const info = adapter.info;
    const parts = [info.vendor, info.architecture, info.description].filter((p): p is string => !!p);
    return parts.length ? parts.join(" ") : "unknown";
  } catch {
    return "unknown";
  }
}

/** navigator.deviceMemory reports an approximate, privacy-capped figure (0.25..8 GiB; real RAM
 *  above 8 GiB is not distinguishable from exactly 8 GiB by design), so this can only ever produce
 *  "under_8gb", "8gb", or "unknown" -- the schema's larger buckets exist for signals this probe
 *  doesn't have (docs/PLAN.md S1-11 v3, env.ram_bucket). */
function ramBucket(): BugReportEnv["ram_bucket"] {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof mem !== "number" || !Number.isFinite(mem)) return "unknown";
  return mem < 8 ? "under_8gb" : "8gb";
}

function osString(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  if (/Mac OS X/.test(ua)) return `macos ${/Mac OS X (\d+)/.exec(ua)?.[1] ?? ""}`.trim();
  if (/Windows NT/.test(ua)) return `windows ${/Windows NT (\d+)/.exec(ua)?.[1] ?? ""}`.trim();
  if (/Android/.test(ua)) return `android ${/Android (\d+)/.exec(ua)?.[1] ?? ""}`.trim();
  if (/iPhone|iPad/.test(ua)) return `ios ${/OS (\d+)_/.exec(ua)?.[1] ?? ""}`.trim();
  if (/Linux/.test(ua)) return "linux";
  return "unknown";
}

/** navigator.platform is long-deprecated but still the cheapest cross-browser hint of the CPU
 *  family ("MacIntel", "Win32", ...); "unknown" when it's unavailable rather than guessing. */
function chipString(): string {
  const platform = (navigator as Navigator & { platform?: string }).platform;
  return platform || "unknown";
}

async function buildEnv(): Promise<BugReportEnv> {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  return {
    ua: clip(ua, ENV_MAX.ua),
    gpu: clip(await probeGpu(), ENV_MAX.gpu),
    os: clip(osString(), ENV_MAX.os),
    chip: clip(chipString(), ENV_MAX.chip),
    ram_bucket: ramBucket(),
  };
}

// ---------------------------------------------------------------- models
/** The model(s) actually in play for the most recent run (not simply every pinned tier): the
 *  voice model always (rule 11: it loads on page load in the common case), plus whichever
 *  summarizer tier the last non-Read-all run actually used, matched back to its pinned revision
 *  (docs/PLAN.md S1-11 v3: "models: [{id, rev}] from pins"). */
function activeModels(stats: OrchestratorStats): BugReportModel[] {
  const { voice } = pinnedModels().web;
  const models: BugReportModel[] = [{ id: voice.id, rev: voice.revision }];
  const level = stats.last?.level;
  if (level && level !== "readall") {
    const tiers = summarizerTiers();
    const tier = tiers.find((t) => t.id === stats.gen?.model_id) ?? tiers[0];
    models.push({ id: tier.id, rev: tier.revision });
  }
  return models;
}

// ---------------------------------------------------------------- sanitizers (defense in depth)
/** Copies only the fields run-stats.schema.json actually defines (CSV_FIELDS, stats/schema.ts's
 *  own list, sourced from that schema's `required` array), in case a caller ever hands in a row
 *  object carrying an extra property alongside a valid StatsRow -- so that property, whatever it
 *  is, never reaches a report or a URL (mirrors stats/store.ts buildRow's own comment). */
function sanitizeRow(row: StatsRow): StatsRow {
  const clean = {} as Record<string, unknown>;
  const src = row as unknown as Record<string, unknown>;
  for (const f of CSV_FIELDS) clean[f] = src[f];
  return clean as unknown as StatsRow;
}

/** Same defense for one Event: only "event"/"t_ms" and only EVENT_FIELD_KEYS survive. */
function sanitizeEvent(e: Event): Event {
  const fields = {} as EventFields;
  const src = e.fields as unknown as Record<string, unknown>;
  for (const k of EVENT_FIELD_KEYS) {
    if (k in src) (fields as Record<string, unknown>)[k] = src[k];
  }
  return { event: e.event, t_ms: e.t_ms, fields };
}

// ---------------------------------------------------------------- buildReport
export interface BuildReportInput {
  /** `orchestrator().stats()` -- the live/most-recent run, used only to pick which model(s) were
   *  actually active (activeModels above); never spread into the report. */
  orchestratorStats: OrchestratorStats;
  /** Persisted RunStats rows (stats/store.ts `rows()`), oldest first; the last <= 5 are kept. */
  rows: StatsRow[];
  /** Structured events (engine/events.ts `events()`), oldest first; the last <= 50 are kept. */
  events: Event[];
  /** The user's own typed description of the bug. Component state only (ui/Report.tsx) -- this
   *  function never reads or writes storage, so a description never touches localStorage. */
  description: string;
}

/** Assemble a `BugReport` envelope. Pure and side-effect-free: it never touches localStorage
 *  (the one thing the packet requires stay true even when a description is included) and never
 *  persists anything -- the envelope is built fresh each time the report modal wants one and is
 *  discarded the moment the modal closes. */
export async function buildReport({ orchestratorStats, rows, events, description }: BuildReportInput): Promise<BugReport> {
  return {
    app: "web",
    version: versionJson.web,
    env: await buildEnv(),
    models: activeModels(orchestratorStats),
    run_stats: rows.slice(-MAX_RUN_STATS).map(sanitizeRow),
    events: events.slice(-MAX_EVENTS).map(sanitizeEvent),
    user_description: clip(description, MAX_DESCRIPTION),
  };
}

/** `validateBugReport` re-exported from here so callers of this module (ui/Report.tsx, tests)
 *  don't need a second import path to check what buildReport just built. */
export { validateBugReport };
export type { ValidationResult };

// ---------------------------------------------------------------- title / URL / copy text
/** A short, user-text-free symptom for the title: the last structured event's name (and reason,
 *  when it has one), never anything from user_description or source text. */
function shortSymptom(report: BugReport): string {
  const last = report.events[report.events.length - 1];
  if (!last) return "no events";
  const words = last.fields.reason ? `${last.event} ${last.fields.reason}` : last.event;
  return words.replace(/_/g, " ");
}

function reportLevel(report: BugReport): string {
  const lastRow = report.run_stats[report.run_stats.length - 1];
  return lastRow?.level ?? "unknown";
}

/** `bug: <level> <target> <short symptom>` -- built entirely from structured fields already in
 *  the report (PLAN-REVIEW-LOG.md #26's fix applies here too: nothing from user_description ever
 *  lands in a URL param GitHub treats specially, and the title is no exception). */
function buildTitle(report: BugReport): string {
  return `bug: ${reportLevel(report)} ${report.app} ${shortSymptom(report)}`;
}

/** Builds the `.github/ISSUE_TEMPLATE/bug.yml` field-param URL for `report`, trimming the oldest
 *  events first and then the oldest run_stats rows until the final encoded URL is
 *  <= MAX_URL_LENGTH chars (docs/PLAN.md S1-11 v3 and PLAN-REVIEW-LOG.md #26: explicit field ids,
 *  a URL length cap measured on the encoded URL, not the raw JSON). The title is computed once,
 *  before any trimming, so it never flips mid-trim. */
export function buildIssueUrl(report: BugReport): string {
  const title = buildTitle(report);
  const events = [...report.events];
  const runStats = [...report.run_stats];
  let description = report.user_description;

  const build = (): string => {
    const params = new URLSearchParams();
    params.set("template", "bug.yml");
    params.set("title", title);
    params.set("what_happened", description);
    params.set("env", JSON.stringify(report.env, null, 2));
    params.set("models", JSON.stringify(report.models, null, 2));
    params.set("run_stats", JSON.stringify(runStats, null, 2));
    params.set("events", JSON.stringify(events, null, 2));
    params.set("app_version", `${report.app} ${report.version}`);
    return `${REPO_URL}/issues/new?${params.toString()}`;
  };

  let url = build();
  while (url.length > MAX_URL_LENGTH && events.length > 0) {
    events.shift(); // oldest first
    url = build();
  }
  while (url.length > MAX_URL_LENGTH && runStats.length > 0) {
    runStats.shift(); // oldest first, only once every event is already gone
    url = build();
  }
  // A long description can exceed the budget on its own once encoded: clip it last, in steps,
  // so the URL always fits (Codex review, PR #23). The full text stays in "Copy report".
  while (url.length > MAX_URL_LENGTH && description.length > 0) {
    description = description.slice(0, Math.max(0, description.length - 200));
    url = build();
  }
  return url;
}

/** The clipboard fallback ("Copy report"): the full, untrimmed report as pretty JSON. */
export function buildCopyText(report: BugReport): string {
  return JSON.stringify(report, null, 2);
}
