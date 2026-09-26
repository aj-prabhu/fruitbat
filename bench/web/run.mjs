#!/usr/bin/env node
// bench/web/run.mjs -- S1-13's web bench runner (docs/PLAN.md rule 3, KPI table, bench/README.md,
// bench/identity.md). Drives the real app (bundled Chromium, headed, WebGPU on) through
// doc x level x rep, reads the RunStats row the app itself already wrote to localStorage
// (web/src/stats/store.ts's record()), fills in the metrics only a Node harness can measure
// (facts_token_hit/halluc_flags/forbidden_hits/oneline_keyword_hit via bench/score.py, peak_mb via
// `ps`, heap_mb via CDP Performance.getMetrics), validates the row with bench/schema_check.py, and
// appends it to bench/results.csv in the schema's fixed column order. Called by bench/run.sh
// --target web; never invoked directly by CI (no baseline writes happen here).
//
// Why the app's own row, not one we build ourselves: buildRow() (web/src/stats/store.ts) already
// knows the pinned model_id/model_rev/dtype/device for whichever tier actually loaded, the browser
// commit embedded at build time (vite.config.ts's __FRUITBAT_COMMIT__), and the UA-derived
// browser/os fields -- reproducing that logic here would drift the moment a pin changes. This
// harness only adds what genuinely cannot be known inside the page: the diagnostic scorer's
// numbers (they grade against the eval corpus, not the live pipeline) and process-level memory.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // bench/web
const REPO_ROOT = path.resolve(HERE, "..", "..");
const WEB_DIR = path.join(REPO_ROOT, "web");
const BENCH_DIR = path.join(REPO_ROOT, "bench");
const CORPUS_DIR = path.join(REPO_ROOT, "spec", "eval", "corpus");
const RESULTS_CSV = path.join(BENCH_DIR, "results.csv");
const SCHEMA_PATH = path.join(REPO_ROOT, "spec", "schemas", "run-stats.schema.json");
const LAST_RUN_DIR = path.join(BENCH_DIR, "last-run");

const ALL_LEVELS = ["readall", "short", "caveman", "oneline"];
// Maxes the product's own persisted speech-rate setting (web/src/engine/tts.ts, RATE_MAX = 1.5) on
// every page load, cutting real playback wait time by a third. This is a supported dial control,
// not a hack, but it does mean gap_ms/rtf on these rows reflect 1.5x speech rather than the
// default 1.0x -- noted in the runner's report, doesn't affect ttfa_ms/tok_s/facts_token_hit.
const BENCH_RATE = 1.5;
async function primeRate(context) {
  await context.addInitScript((rate) => {
    try {
      localStorage.setItem("fruitbat.rate", String(rate));
    } catch {
      // private mode / blocked storage: falls back to the default rate, just slower
    }
  }, BENCH_RATE);
}
const WEBGPU_ARGS = [
  "--enable-unsafe-webgpu",
  "--ignore-gpu-blocklist",
  "--mute-audio",
  "--autoplay-policy=no-user-gesture-required",
];
// Only bench's own output files may be dirty when we start (docs/PLAN.md rule 3's evidence
// pathspec carve-out mirrored for the runner itself; bench/last-run/* is gitignored except the
// S0-05 fixture, see .gitignore).
const DIRTY_EXCEPTIONS = [".", ":!bench/results.csv", ":!bench/baselines.json", ":!bench/last-run"];

/** A run failure. Thrown, not process.exit(): main()'s `finally` must still close Chromium and
 *  stop vite preview, and a cold rep's temp profile must still be removed (Codex review, PR #27). */
class BenchFailure extends Error {}
function fail(msg) {
  throw new BenchFailure(msg);
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --------------------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { docs: null, levels: "all", cache: "warm", reps: 3, port: 4251 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--docs":
        out.docs = next();
        break;
      case "--levels":
        out.levels = next();
        break;
      case "--cache":
        out.cache = next();
        break;
      case "--reps":
        out.reps = Number(next());
        break;
      case "--port":
        out.port = Number(next());
        break;
      default:
        fail(`unknown argument '${a}'`);
    }
  }
  if (!["warm", "cold"].includes(out.cache)) fail(`--cache must be 'warm' or 'cold', got '${out.cache}'`);
  if (!Number.isInteger(out.reps) || out.reps < 1) fail(`--reps must be a positive integer, got '${out.reps}'`);
  return out;
}

function resolveDocs(spec, manifest) {
  const allIds = manifest.docs.map((d) => d.id);
  if (!spec) return allIds.slice(0, 3); // default: first 3 corpus ids
  if (spec.includes(",")) {
    const ids = spec.split(",").map((s) => s.trim());
    for (const id of ids) if (!allIds.includes(id)) fail(`--docs: unknown doc id '${id}'`);
    return ids;
  }
  if (allIds.includes(spec)) return [spec]; // a single explicit 3-digit id, e.g. "011"
  const n = Number(spec);
  if (!Number.isInteger(n) || n <= 0) fail(`--docs: '${spec}' is neither a known doc id nor a positive integer count`);
  return allIds.slice(0, n);
}

function resolveLevels(spec) {
  if (!spec || spec === "all") return ALL_LEVELS;
  const levels = spec.split(",").map((s) => s.trim());
  for (const l of levels) if (!ALL_LEVELS.includes(l)) fail(`--levels: unknown level '${l}'`);
  return levels;
}

// --------------------------------------------------------------------------------------
// Preflight: clean tree, commit, build, preview server
// --------------------------------------------------------------------------------------

function assertCleanTree() {
  const res = sh("git", ["status", "--porcelain", "--", ...DIRTY_EXCEPTIONS], { cwd: REPO_ROOT });
  if (res.status !== 0) fail(`git status failed: ${res.stderr}`);
  const dirty = res.stdout.trim();
  if (dirty) {
    fail(
      `refusing to run with a dirty tree (only bench/results.csv, bench/baselines.json, ` +
        `bench/last-run/ may be dirty):\n${dirty}`
    );
  }
}

function currentCommit() {
  return sh("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.trim();
}

function buildApp() {
  console.log("bench/web/run.mjs: npm run build ...");
  const res = spawnSync("npm", ["run", "build"], { cwd: WEB_DIR, stdio: "inherit" });
  if (res.status !== 0) fail("npm run build failed");
}

function startPreview(port) {
  return spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], {
    cwd: WEB_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function assertPortFree(url) {
  // --strictPort makes our own preview exit if the port is taken, and the readiness poll below would
  // then happily measure whatever else answers there (Codex review, PR #27).
  try {
    await fetch(url);
  } catch {
    return; // nothing listening: good
  }
  fail(`${url} already has a server on it; stop it or pass --port`);
}

async function waitForServer(url, preview, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (preview.exitCode !== null) fail(`vite preview exited (code ${preview.exitCode}) before serving ${url}`);
    try {
      const res = await fetch(url);
      if (res.status) return;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  fail(`preview server at ${url} did not come up within ${timeoutMs}ms`);
}

function loadPlaywright() {
  // @playwright/test lives in web/node_modules, not bench/web/node_modules or the repo root, so
  // resolve it relative to web/package.json rather than relying on ESM's own resolution (which
  // walks up from this file's directory, a sibling of web/, and would never find it).
  const require = createRequire(path.join(WEB_DIR, "package.json"));
  return require("@playwright/test");
}

/** Load the app and wait for cross-origin isolation through coi-serviceworker's one-time reload
 *  (a fresh profile gets it on every cold rep), reloading once more if it has not arrived, like
 *  web/tests/isolated.ts (Codex review, PR #27). */
async function gotoIsolated(page, url) {
  await page.goto(url);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.waitForFunction(() => crossOriginIsolated === true, null, { timeout: 15_000 });
      await page.waitForLoadState("load");
      return;
    } catch {
      await page.reload();
    }
  }
  fail(`crossOriginIsolated never became true at ${url}`);
}

// --------------------------------------------------------------------------------------
// Process-level memory (peak_mb via ps, heap_mb via CDP)
// --------------------------------------------------------------------------------------

// Chromium forwards --user-data-dir to its renderer and gpu-process children (verified against
// this exact bundled build: both show it in `ps`), so grepping ps by the profile dir plus
// --type=renderer|gpu-process reliably finds the pids for *this* browser instance even with other
// Chrome/Chromium processes running on the machine. If a future Chromium build stops doing this,
// findPids returns [] and peak_mb comes back null (memory.md documents this as the fallback).
function findPids(profileDir) {
  const res = sh("ps", ["-eo", "pid,command"], { maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) return [];
  const pids = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.includes(profileDir)) continue;
    if (!/--type=(renderer|gpu-process)\b/.test(line)) continue;
    const m = /^\s*(\d+)/.exec(line);
    if (m) pids.push(m[1]);
  }
  return pids;
}

function sampleRssMb(pids) {
  if (pids.length === 0) return null;
  const res = sh("ps", ["-o", "rss=", "-p", pids.join(",")]);
  if (res.status !== 0) return null;
  const kb = res.stdout
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .reduce((a, b) => a + b, 0);
  return kb > 0 ? kb / 1024 : null;
}

function startPeakSampler(profileDir) {
  const pids = findPids(profileDir);
  if (pids.length === 0) {
    // Fragile by design (docs/PLAN.md packet text): record null and say so rather than guess.
    return { stop: () => null, samples: () => 0 };
  }
  let peak = 0;
  let samples = 0;
  const timer = setInterval(() => {
    const mb = sampleRssMb(pids);
    if (mb !== null) {
      peak = Math.max(peak, mb);
      samples++;
    }
  }, 250);
  return {
    stop() {
      clearInterval(timer);
      return samples > 0 ? peak : null;
    },
  };
}

// --------------------------------------------------------------------------------------
// score.py / schema_check.py shell-outs
// --------------------------------------------------------------------------------------

function extractScoringText(level, bullets) {
  if (level === "oneline") {
    const finalLine = bullets.find((b) => b.chunkIndex === -1);
    if (finalLine) return finalLine.text;
    // No chunkIndex===-1 bullet made it through (e.g. One line fell back to Short, docs/PLAN.md
    // "One-line policy on failures"): fall back to joining what we have so scoring still runs.
    console.warn("bench/web/run.mjs: no final one-line bullet (chunkIndex -1); scoring joined bullets instead");
  }
  return bullets.map((b) => b.text).join("\n");
}

function scoreOutput(doc, level, outFile) {
  const res = sh("python3", [path.join(BENCH_DIR, "score.py"), "--doc", doc, "--level", level, "--output", outFile], {
    cwd: REPO_ROOT,
  });
  if (res.status !== 0) fail(`bench/score.py failed for doc=${doc} level=${level}:\n${res.stdout}${res.stderr}`);
  return JSON.parse(res.stdout);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function validateAndAppend(csvFields, row) {
  const cleanRow = {};
  for (const f of csvFields) cleanRow[f] = row[f] === undefined ? null : row[f];
  const tmpFile = path.join(os.tmpdir(), `fruitbat-row-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(cleanRow, null, 2));
  const res = sh("python3", [path.join(BENCH_DIR, "schema_check.py"), tmpFile, SCHEMA_PATH]);
  fs.rmSync(tmpFile, { force: true });
  if (res.status !== 0) {
    fail(`bench/schema_check.py rejected the row for doc=${row.doc_id} level=${row.level}:\n${res.stdout}${res.stderr}`);
  }
  const line = csvFields.map((f) => csvCell(cleanRow[f])).join(",") + "\n";
  fs.appendFileSync(RESULTS_CSV, line);
  return cleanRow;
}

// --------------------------------------------------------------------------------------
// One measurement: trigger, wait for gen+voice idle (main.tsx's own record() condition), measure
// --------------------------------------------------------------------------------------

// The wait condition (voice.enqueued <= voice.ended) requires every spoken segment to actually
// finish PLAYING, not just be synthesized -- the AudioContext clock runs in real time regardless
// of --mute-audio, so a run's true duration is generation time plus the real-time length of
// whatever gets spoken. That's the whole document for readall (proportional to word count) and a
// handful of short bullets per chunk for short/caveman (bounded by dial.json's
// max_bullets_per_chunk), or a single final line for oneline (dial.json: "only the final line is
// spoken"). RUN_MJS_RATE below maxes the product's own speech-rate setting (0.7-1.5,
// web/src/engine/tts.ts RATE_MAX) to cut real playback time by a third; timeouts still budget for
// the unsped floor so a slower machine doesn't get killed early.
// Measured empirically against this exact shared machine (2026-09-25): first model
// instantiation in a fresh page (WebGPU pipeline/shader setup plus Cache-API-served weights, not
// a network download) took ~108s on its own, on top of generation and playback -- and varied
// noticeably run to run under concurrent load from other agent sessions on the same machine. That
// cost is paid once per page (warm mode's warm-up call, or every rep in cold mode's fresh
// contexts); the other 36 warm measured calls reuse the already-loaded in-memory engine and skip
// it entirely (confirmed: the first smoke test's second, measured call had ttfa_ms=8234).
const MODEL_LOAD_CUSHION_MS = 480_000;

function computeTimeoutMs(text, level, cold, { warmup = false } = {}) {
  const words = text.trim().split(/\s+/).length;
  const chunks = Math.max(1, Math.ceil(words / 1200)); // spec/chunking.md's ~1600-token budget, ~1200 words/chunk
  let ms;
  if (level === "readall") {
    // Real-time narration of the whole document dominates. 90 wpm is a conservative (slow) floor
    // -- real speech is usually faster -- chosen so a legitimately slower run never gets killed.
    ms = (words / 90) * 60_000 + 120_000;
  } else if (level === "oneline") {
    // Only the final line is spoken; generation is per-chunk one-liners plus a bounded reduce
    // pass (dial.json: group size 10, depth <= 2), not proportional to bullet count.
    ms = chunks * 40_000 + 120_000;
  } else {
    // short/caveman: up to max_bullets_per_chunk spoken bullets per chunk, each a few seconds of
    // speech, plus that chunk's generation time.
    ms = chunks * 120_000 + 120_000;
  }
  // The model-load cushion applies to the warm-up call (always a fresh page) and to every cold
  // rep (always a fresh context/profile) -- not to warm mode's 36 measured calls, which reuse an
  // already-loaded engine and would otherwise be given far more headroom than they need.
  if (warmup || cold) ms += MODEL_LOAD_CUSHION_MS;
  return Math.min(Math.max(ms, 60_000), 180 * 60_000); // clamp 1..180 minutes
}

async function measureStop(page, doc, level, text, timeoutMs) {
  const runId = await page.evaluate(
    ({ doc, level, text }) => {
      window.__fruitbat.setDocId(doc);
      window.__fruitbat.run(text, level);
      return window.__fruitbat.state().runId;
    },
    { doc, level, text }
  );
  // Playing, or the run ended without ever playing (every bullet cut, a failed load): then there is
  // no audio to stop and nothing to measure (Codex review, PR #27).
  await page.waitForFunction(
    (runId) => {
      const s = window.__fruitbat.state();
      return s.runId === runId && (s.play === "playing" || s.settledRunId === runId);
    },
    runId,
    { timeout: timeoutMs, polling: 50 }
  );
  const played = await page.evaluate(() => window.__fruitbat.state().play === "playing");
  if (!played) {
    console.warn(`bench/web/run.mjs: stop probe for doc=${doc} level=${level} never played; stop_ms left empty`);
    return null;
  }
  const ms = await page.evaluate(() => {
    window.__fruitbat.stop(); // the orchestrator measures the stop synchronously
    return window.__fruitbat.stats().stop_ms;
  });
  if (typeof ms !== "number" || !Number.isFinite(ms)) fail(`stop_ms not measured for doc=${doc} level=${level}`);
  return ms;
}

async function runOnce(page, cdp, profileDir, doc, level, { text, timeoutMs, discard = false }) {
  const sampler = discard ? null : startPeakSampler(profileDir);

  // The row this rep must produce is the one after these (Codex review, PR #27): if the app rejects
  // its row or the localStorage write fails, the last row would still be the previous rep's.
  const before = await page.evaluate(() => {
    const rows = window.__fruitbat.rows();
    return { count: rows.length, lastDate: rows.length ? rows[rows.length - 1].date : null };
  });
  const runId = await page.evaluate(
    ({ doc, level, text }) => {
      window.__fruitbat.setDocId(doc);
      window.__fruitbat.run(text, level);
      return window.__fruitbat.state().runId;
    },
    { doc, level, text }
  );

  // Mirrors web/src/main.tsx's own record() gate exactly: gen terminal AND the voice queue has
  // drained. Reading state() (not stats()) because voice.inFlight/enqueued/ended aren't on
  // FruitbatStats.
  await page.waitForFunction(
    (runId) => {
      const s = window.__fruitbat.state();
      // The same condition main.tsx records on: the orchestrator's explicit settlement of this run
      // (generation and speech both over, metrics final). Queue counters alone can go idle first,
      // and then the last row read below would be the previous rep's (Codex review, PR #22).
      return s.runId === runId && (s.gen === "done" || s.gen === "failed") && s.settledRunId === runId;
    },
    runId,
    { timeout: timeoutMs, polling: 250 }
  );

  if (discard) {
    sampler?.stop();
    return null;
  }

  const peak_mb = sampler.stop();
  const perf = await cdp.send("Performance.getMetrics");
  const heapEntry = perf.metrics.find((m) => m.name === "JSHeapUsedSize");
  const heap_mb = heapEntry ? heapEntry.value / 1e6 : null;

  const allRows = await page.evaluate(() => window.__fruitbat.rows());
  const row = allRows[allRows.length - 1];
  // New = more rows than before, or (at the 200-row cap) a different last row.
  const fresh = row && (allRows.length > before.count || row.date !== before.lastDate);
  if (!fresh || row.doc_id !== doc || row.level !== level) {
    fail(`expected a fresh RunStats row for doc=${doc} level=${level}, got ${JSON.stringify(row)}`);
  }
  row.peak_mb = peak_mb;
  row.heap_mb = heap_mb;

  if (level !== "readall") {
    const bullets = await page.evaluate(() => window.__fruitbat.state().bullets);
    const scoringText = extractScoringText(level, bullets);
    fs.mkdirSync(LAST_RUN_DIR, { recursive: true });
    // "bench-" prefix: <level>-<doc>.txt would overwrite the committed S1-05 fixture short-011.txt.
    const outFile = path.join(LAST_RUN_DIR, `bench-${level}-${doc}.txt`);
    fs.writeFileSync(outFile, scoringText, "utf8");
    const scored = scoreOutput(doc, level, outFile);
    row.facts_token_hit = scored.facts_token_hit;
    row.halluc_flags = scored.halluc_flags;
    row.forbidden_hits = scored.forbidden_hits;
    row.oneline_keyword_hit = scored.oneline_keyword_hit;
  }

  // stop_ms, measured last: the probe starts a new run, which clears this run's bullets, so it only
  // happens after they were scored (Codex review, PR #27). The app never records stop_ms on a row
  // (a stopped run is never a row, S1-10); the runner starts the same run again, presses Stop once
  // audio plays, and takes the engine's measured stop time. bench/gate.py requires it.
  row.stop_ms = await measureStop(page, doc, level, text, timeoutMs);
  return row;
}

// --------------------------------------------------------------------------------------
// Summary table
// --------------------------------------------------------------------------------------

function median(arr) {
  const nums = arr.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function fmt(v) {
  if (v === null || v === undefined) return "null";
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

function printSummaryTable(summaries) {
  const cols = ["doc", "level", "ttfa_ms(med)", "tok_s(med)", "facts_token_hit(med)", "cut_rate(med)"];
  const rows = summaries.map((s) => [s.doc, s.level, fmt(s.ttfa_ms), fmt(s.tok_s), fmt(s.facts_token_hit), fmt(s.cut_rate)]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join(" | ");
  console.log(line(cols));
  console.log(widths.map((w) => "-".repeat(w)).join("-|-"));
  for (const r of rows) console.log(line(r));
}

// --------------------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertCleanTree();
  const commit = currentCommit();
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "spec/eval/manifest.json"), "utf8"));
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const csvFields = schema.required;

  const docs = resolveDocs(args.docs, manifest);
  const levels = resolveLevels(args.levels);
  const { cache, reps, port } = args;

  console.log(
    `bench/web/run.mjs: commit=${commit} docs=${docs.join(",")} levels=${levels.join(",")} cache=${cache} reps=${reps} port=${port}`
  );

  buildApp();
  const baseURL = `http://localhost:${port}`;
  await assertPortFree(baseURL);
  const preview = startPreview(port);
  const summaries = [];
  let appendedCount = 0;

  const cleanupFns = [() => preview.kill()];
  // Awaited, so Chromium has actually closed (and a cold rep's temp profile is released) before the
  // runner exits, on success, on a failure, or on Ctrl-C (Codex review, PR #27).
  const cleanup = async () => {
    for (const fn of cleanupFns.splice(0).reverse()) {
      try {
        await fn();
      } catch {
        // best-effort
      }
    }
  };
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(130));
  });

  try {
    await waitForServer(baseURL, preview);
    const { chromium } = loadPlaywright();

    async function measureMatrix(page, cdp, profileDir) {
      for (const doc of docs) {
        const text = fs.readFileSync(path.join(CORPUS_DIR, `${doc}.txt`), "utf8");
        for (const level of levels) {
          const repRows = [];
          for (let r = 0; r < reps; r++) {
            const timeoutMs = computeTimeoutMs(text, level, cache === "cold");
            const row = await runOnce(page, cdp, profileDir, doc, level, { text, timeoutMs });
            const clean = validateAndAppend(csvFields, row);
            appendedCount++;
            repRows.push(clean);
            console.log(
              `  [${doc}/${level}/rep${r + 1}] ttfa_ms=${clean.ttfa_ms} tok_s=${clean.tok_s} facts_token_hit=${clean.facts_token_hit} cut_rate=${clean.cut_rate}`
            );
          }
          summaries.push({
            doc,
            level,
            ttfa_ms: median(repRows.map((r) => r.ttfa_ms)),
            tok_s: median(repRows.map((r) => r.tok_s)),
            facts_token_hit: median(repRows.map((r) => r.facts_token_hit)),
            cut_rate: median(repRows.map((r) => r.cut_rate)),
          });
        }
      }
    }

    if (cache === "warm") {
      const profileDir = path.join(BENCH_DIR, ".profile-warm");
      fs.mkdirSync(profileDir, { recursive: true });
      const context = await chromium.launchPersistentContext(profileDir, { headless: false, args: WEBGPU_ARGS });
      cleanupFns.push(() => context.close());
      await primeRate(context);
      const page = context.pages()[0] ?? (await context.newPage());
      await gotoIsolated(page, baseURL);
      await page.waitForFunction(() => !!window.__fruitbat, null, { timeout: 30_000 });
      const cdp = await context.newCDPSession(page);
      await cdp.send("Performance.enable");

      // Warm-up: the persistent profile may be empty (first-ever bench run, or a deleted profile
      // dir), which would make the first real measurement pay for the model downloads and get
      // tagged cache_state="cold" -- a different bench identity from every other warm row. One
      // throwaway "short" run on the first doc primes both the summarizer and the voice model
      // (readall only needs the voice model, so "short" covers strictly more); its row is never
      // scored, validated, or appended.
      console.log("bench/web/run.mjs: warm-up run (discarded, not counted in the 36) to prime the model cache...");
      const warmupText = fs.readFileSync(path.join(CORPUS_DIR, `${docs[0]}.txt`), "utf8");
      await runOnce(page, cdp, profileDir, docs[0], "short", {
        text: warmupText,
        timeoutMs: computeTimeoutMs(warmupText, "short", true),
        discard: true,
      });

      await measureMatrix(page, cdp, profileDir);
    } else {
      // cold: a fresh temp profile per rep, closed and removed immediately after.
      for (const doc of docs) {
        const text = fs.readFileSync(path.join(CORPUS_DIR, `${doc}.txt`), "utf8");
        for (const level of levels) {
          const repRows = [];
          for (let r = 0; r < reps; r++) {
            const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "fruitbat-bench-cold-"));
            const context = await chromium.launchPersistentContext(tmpProfile, { headless: false, args: WEBGPU_ARGS });
            try {
              await primeRate(context);
              const page = context.pages()[0] ?? (await context.newPage());
              await gotoIsolated(page, baseURL);
              await page.waitForFunction(() => !!window.__fruitbat, null, { timeout: 30_000 });
              const cdp = await context.newCDPSession(page);
              await cdp.send("Performance.enable");
              const timeoutMs = computeTimeoutMs(text, level, true);
              const row = await runOnce(page, cdp, tmpProfile, doc, level, { text, timeoutMs });
              const clean = validateAndAppend(csvFields, row);
              appendedCount++;
              repRows.push(clean);
              console.log(
                `  [${doc}/${level}/rep${r + 1}/cold] ttfa_ms=${clean.ttfa_ms} tok_s=${clean.tok_s} facts_token_hit=${clean.facts_token_hit} cut_rate=${clean.cut_rate}`
              );
            } finally {
              await context.close();
              fs.rmSync(tmpProfile, { recursive: true, force: true });
            }
          }
          summaries.push({
            doc,
            level,
            ttfa_ms: median(repRows.map((r) => r.ttfa_ms)),
            tok_s: median(repRows.map((r) => r.tok_s)),
            facts_token_hit: median(repRows.map((r) => r.facts_token_hit)),
            cut_rate: median(repRows.map((r) => r.cut_rate)),
          });
        }
      }
    }

    console.log("");
    printSummaryTable(summaries);
    console.log(`\nbench/web/run.mjs: appended ${appendedCount} rows to bench/results.csv`);
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error("bench/web/run.mjs:", err instanceof BenchFailure ? err.message : (err?.stack ?? err));
  process.exit(1);
});
