// The stats store (docs/PLAN.md S1-10, Architecture "Stats store", C11). One `StatsRow` per
// finished run: assembled by the pure `buildRow`, checked against run-stats.schema.json by
// `validateRunStats` (stats/schema.ts), then appended to localStorage under retention. No source
// text, bullets, audio, file name, or URL is ever a candidate field here (Non-negotiable 1):
// `buildRow` only ever copies numbers/enums it already typed itself, never an arbitrary property
// off the orchestrator's stats object, so a stray free-text field on that object (a bug upstream)
// cannot reach storage even before the schema validator would reject it.
import type { OrchestratorStats } from "../engine/orchestrator";
import { pinnedModels, summarizerTiers } from "../engine/pins";
import { CSV_FIELDS, validateRunStats, type StatsRow } from "./schema";

export type { StatsRow } from "./schema";

export const STORAGE_KEY = "fruitbat.stats";
export const ERRORS_KEY = "fruitbat.stats.errors";
export const RETENTION = 200;

export interface StatsEnv {
  browser: StatsRow["browser"];
  browser_major: number | null;
  os: StatsRow["os"];
  os_major: number;
  machine_id: string;
  commit: string;
  date: string;
  doc_id: string;
}

// ---------------------------------------------------------------- doc_id (bench injection point)
let docId = "paste";

/** `window.__fruitbat.setDocId(id)`: the bench harness (S1-13) tags rows with the eval corpus id
 *  it is driving; every other caller (real usage, not the corpus) leaves this as "paste". */
export function setDocId(id: string): void {
  docId = id;
}

export function getDocId(): string {
  return docId;
}

// ---------------------------------------------------------------- environment
function pick(re: RegExp, ua: string): number | null {
  const m = re.exec(ua);
  return m ? Number(m[1]) : null;
}

/** UA -> the schema's closed browser/os enums. Unrecognized browsers map to "none" and
 *  unrecognized OSes to "linux" (the schema has no "other" for os) rather than guessing. */
export function detectUA(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): {
  browser: StatsRow["browser"];
  browser_major: number | null;
  os: StatsRow["os"];
  os_major: number;
} {
  let browser: StatsRow["browser"] = "none";
  let browser_major: number | null = null;
  if (/Firefox\//.test(ua)) {
    browser = "firefox";
    browser_major = pick(/Firefox\/(\d+)/, ua);
  } else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) {
    browser = "chrome";
    browser_major = pick(/Chrome\/(\d+)/, ua);
  } else if (/Safari\//.test(ua) && /Version\//.test(ua)) {
    browser = "safari";
    browser_major = pick(/Version\/(\d+)/, ua);
  }
  let os: StatsRow["os"] = "linux";
  let os_major = 0;
  if (/iPhone|iPad/.test(ua)) {
    os = "ios";
    os_major = pick(/OS (\d+)_/, ua) ?? 0;
  } else if (/Android/.test(ua)) {
    os = "android";
    os_major = pick(/Android (\d+)/, ua) ?? 0;
  } else if (/Mac OS X/.test(ua)) {
    os = "macos";
    os_major = pick(/Mac OS X (\d+)/, ua) ?? 0;
  } else if (/Windows NT/.test(ua)) {
    os = "windows";
    os_major = pick(/Windows NT (\d+)/, ua) ?? 0;
  }
  return { browser, browser_major, os, os_major };
}

/** The build commit (vite.config.ts `define`s `__FRUITBAT_COMMIT__` from `git rev-parse
 *  --short HEAD`, falling back to "dev" when git is unavailable at build time). Under Vitest
 *  (a separate config with no such `define`) the identifier is simply undefined, hence the
 *  `typeof` guard: referencing an undeclared global directly would throw, `typeof` never does. */
function buildCommit(): string {
  return typeof __FRUITBAT_COMMIT__ !== "undefined" ? __FRUITBAT_COMMIT__ : "dev";
}

/** Everything `buildRow` needs that isn't in the orchestrator's own stats: gathered fresh so
 *  `record()` always uses "now". Exported so a caller (tests, the NICE Stats view) can build one
 *  without calling `record()`; `buildRow` itself stays a pure function of its two arguments. */
export function detectEnv(): StatsEnv {
  const ua = detectUA();
  return { ...ua, machine_id: "web", commit: buildCommit(), date: new Date().toISOString(), doc_id: getDocId() };
}

// ---------------------------------------------------------------- buildRow
/** Assemble one `StatsRow` from the orchestrator's stats (gen + voice + timings), the pinned
 *  model spec, and the environment. Pure: every field is either copied from `stats`/`env` through
 *  a typed accessor or defaulted, never spread from an untyped object, so an unexpected property
 *  anywhere on `stats` can never end up on the row (Non-negotiable 1). */
export function buildRow(stats: OrchestratorStats, env: StatsEnv): StatsRow {
  const level = stats.last?.level ?? "short";
  const gen = stats.gen;
  const voiceRun = stats.voice_run;
  const voiceRow = stats.voice;

  let model_id: string;
  let model_rev: string;
  let dtype: string;
  let device: StatsRow["device"];
  if (level === "readall") {
    // No summarizer runs for Read all (Architecture "Pipeline"): the row's model identity is the
    // voice model, and its device/dtype come from the measured run when we have one.
    const voice = pinnedModels().web.voice;
    model_id = voice.id;
    model_rev = voice.revision;
    dtype = voiceRun?.dtype ?? voiceRow?.dtype ?? voice.dtype;
    device = (voiceRun?.device ?? voiceRow?.device ?? voice.device) as StatsRow["device"];
  } else {
    // Short / Caveman / One line: the row's model identity is whichever summarizer tier actually
    // loaded (gen.model_id), matched back to its pinned revision/dtype/device; unknown or not-yet-
    // loaded falls back to the default tier so the row still validates.
    const tiers = summarizerTiers();
    const tier = tiers.find((t) => t.id === gen?.model_id) ?? tiers[0];
    model_id = tier.id;
    model_rev = tier.revision;
    dtype = tier.dtype;
    device = tier.device as StatsRow["device"];
  }

  const cache_state: StatsRow["cache_state"] = voiceRow?.cache_state === "warm" ? "warm" : "cold";

  const bulletsTotal = gen?.bullets_total ?? null;
  const bulletsCut = gen?.bullets_cut ?? null;
  const cutRate = bulletsTotal === null ? null : bulletsTotal > 0 ? (bulletsCut ?? 0) / bulletsTotal : 0;

  return {
    schema_version: 1,
    target: "web",
    device,
    level,
    browser: env.browser,
    browser_major: env.browser_major,
    os: env.os,
    os_major: env.os_major,
    cache_state,
    model_id,
    model_rev,
    dtype,
    doc_id: env.doc_id,
    commit: env.commit,
    date: env.date,
    machine_id: env.machine_id,
    ttfa_ms: stats.ttfa_ms,
    gen_ms: gen?.gen_ms ?? null,
    tok_s: gen?.tok_s ?? null,
    rtf: voiceRun?.rtf ?? voiceRow?.rtf ?? null,
    gap_ms: voiceRun?.gap_ms ?? voiceRow?.gap_ms ?? null,
    stop_ms: stats.stop_ms,
    coverage: level === "readall" ? (voiceRow?.coverage ?? null) : null,
    bullets_total: bulletsTotal,
    bullets_cut: bulletsCut,
    cut_rate: cutRate,
    // Not measurable in the browser at run time: these come from bench/score.py grading real
    // output against the eval corpus (bench/README.md), not from a live pipeline run.
    facts_token_hit: null,
    halluc_flags: null,
    forbidden_hits: null,
    oneline_keyword_hit: null,
    tts_overlimit: voiceRun?.tts_overlimit ?? voiceRow?.tts_overlimit ?? 0,
    peak_mb: null, // Mac only (bench/README.md gate table)
    heap_mb: voiceRow?.heap_mb ?? null,
  };
}

// ---------------------------------------------------------------- localStorage plumbing
function readRows(): StatsRow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StatsRow[]) : [];
  } catch {
    return [];
  }
}

function bumpErrorCount(): void {
  try {
    const n = Number(localStorage.getItem(ERRORS_KEY)) || 0;
    localStorage.setItem(ERRORS_KEY, String(n + 1));
  } catch {
    // storage is unusable even for the one-integer error counter: nothing more can be done, and
    // this must never throw out of record() either way
  }
}

/** Every stored row, oldest first. */
export function rows(): StatsRow[] {
  return readRows();
}

/** How many storage failures (QuotaExceededError or otherwise) `record()` has swallowed. */
export function errorCount(): number {
  try {
    return Number(localStorage.getItem(ERRORS_KEY)) || 0;
  } catch {
    return 0;
  }
}

export function clear(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(ERRORS_KEY);
  } catch {
    // private mode / blocked storage: nothing to clear
  }
}

/** Append one row, oldest evicted past `RETENTION`. A `QuotaExceededError` (or any other
 *  `localStorage` failure) is caught, counted, and never thrown out of `record()`. */
function appendRow(row: StatsRow): void {
  try {
    const current = readRows();
    current.push(row);
    while (current.length > RETENTION) current.shift();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    bumpErrorCount();
  }
}

export interface RecordResult {
  ok: boolean;
  errors: string[];
  row: StatsRow;
}

/** Build a row from the orchestrator's stats, validate it, and persist it if valid. Called when a
 *  run reaches done/failed (not on stop — a stopped run never finished). An invalid row (should
 *  not happen from real orchestrator stats, but the dev build's "dev" commit fallback is one
 *  known way to produce one) is reported, not persisted, and never thrown. */
export function record(stats: OrchestratorStats, env: StatsEnv = detectEnv()): RecordResult {
  const row = buildRow(stats, env);
  const { ok, errors } = validateRunStats(row);
  if (ok) appendRow(row);
  return { ok, errors, row };
}

// ---------------------------------------------------------------- export (NICE)
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV with bench/results.csv's exact header and column order (both are the schema's `required`
 *  array — see stats/schema.ts CSV_FIELDS). */
export function exportCsv(): string {
  const lines = [CSV_FIELDS.join(",")];
  for (const row of readRows()) {
    const r = row as unknown as Record<string, unknown>;
    lines.push(CSV_FIELDS.map((f) => csvCell(r[f])).join(","));
  }
  return lines.join("\n") + "\n";
}
