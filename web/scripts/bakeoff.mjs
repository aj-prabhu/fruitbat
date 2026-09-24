// S1-05 bake-off (docs/PLAN.md S1-05, cut-list size): two summarizer tiers × docs 005/011/025 ×
// short/caveman/oneline × 1 rep on WebGPU, plus two prompt variants on 011 Short for the
// bullet-count problem (docs/qa/prompt-tryouts-2026-09-24.md). Drives /summarize.html through
// window.__llm with Playwright's bundled Chromium (headed, WebGPU, audio muted). Writes every raw
// output to bench/last-run/<level>-<doc>[-<variant>].txt and a JSON table.
//   BASE_URL=http://localhost:4180 node scripts/bakeoff.mjs [--models default,fallback-a] [--docs 005,011,025]
import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const base = process.env.BASE_URL ?? "http://localhost:4173";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1]] : [])).filter((x) => x.length));
const models = (args.models ?? "default,fallback-a").split(",");
const docs = (args.docs ?? "005,011,025").split(",");
const levels = (args.levels ?? "short,caveman,oneline").split(",");
const variants = [
  { name: "system", query: "&prompt=system", doc: "011", level: "short" },
  { name: "chunk600", query: "&chunk=600", doc: "011", level: "short" },
];
const outDir = path.join(root, "bench/last-run");
await mkdir(outDir, { recursive: true });

// "lite" facts hit: a key fact counts when >= 60 % of its content words (>= 4 letters, lowercase)
// appear in the output. bench/score.py (S0-05) replaces this once it lands.
function factsHitLite(output, facts) {
  const out = output.toLowerCase();
  let hit = 0;
  for (const f of facts) {
    const words = f.toLowerCase().match(/[a-z][a-z'-]{3,}|\d[\d,.]*/g) ?? [];
    if (words.length === 0) continue;
    const found = words.filter((w) => out.includes(w)).length;
    if (found / words.length >= 0.6) hit++;
  }
  return facts.length ? Math.round((hit / facts.length) * 100) : null;
}

const browser = await chromium.launch({ headless: false, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const context = await browser.newContext();
const rows = [];
async function ready(page, query) {
  await page.goto(`${base}/summarize.html?${query}`);
  for (let i = 0; i < 3; i++) {
    try {
      await page.waitForFunction(() => crossOriginIsolated === true, null, { timeout: 15000 });
      break;
    } catch {
      await page.waitForLoadState("load");
    }
  }
  await page.waitForFunction(() => window.__llm?.state().ready === true, null, { timeout: 20000 });
}
async function runOne(page, model, doc, level, variant) {
  const text = await readFile(path.join(root, "spec/eval/corpus", `${doc}.txt`), "utf8");
  // facts files come from S0-04b; until that merges, FACTS_DIR may point at its worktree
  let facts = { key_facts: [], expected_oneline_keywords: [] };
  for (const dir of [path.join(root, "spec/eval/corpus"), process.env.FACTS_DIR].filter(Boolean)) {
    try { facts = JSON.parse(await readFile(path.join(dir, `${doc}.facts.json`), "utf8")); break; } catch { /* try next */ }
  }
  const t0 = Date.now();
  const r = await page.evaluate(([t, l]) => window.__llm.summarize(t, l), [text, level]);
  const wall = Date.now() - t0;
  const output = r.bullets.map((b) => `- ${b.text}`).join("\n");
  const name = `${level}-${doc}${variant ? `-${variant}` : ""}${model !== "default" ? `-${model}` : ""}`;
  await writeFile(path.join(outDir, `${name}.txt`), `${model} ${doc} ${level} ${variant ?? ""}\nstate=${r.state} error=${r.error ?? ""} chunks=${r.stats.chunks} bullets_total=${r.stats.bullets_total} cut=${r.stats.bullets_cut} kept=${r.bullets.length} ttfa_ms=${r.stats.ttfa_ms} gen_ms=${r.stats.gen_ms} tok_s=${r.stats.tok_s} wall_ms=${wall} per_chunk_kept=${JSON.stringify(r.stats.per_chunk_kept)}\n\n${output}\n\nRAW:\n${r.raw}\n`);
  const row = {
    model, doc, level, variant: variant ?? null, state: r.state, error: r.error, chunks: r.stats.chunks, bullets_total: r.stats.bullets_total, cut: r.stats.bullets_cut, kept: r.bullets.length,
    per_chunk_kept: r.stats.per_chunk_kept, ttfa_ms: r.stats.ttfa_ms, gen_ms: r.stats.gen_ms, tok_s: r.stats.tok_s, wall_ms: wall,
    facts_hit_lite: level === "oneline" ? null : factsHitLite(output, facts.key_facts ?? []),
    oneline_keyword_hit: level === "oneline" ? Math.round(((facts.expected_oneline_keywords ?? []).filter((k) => output.toLowerCase().includes(k.toLowerCase())).length / Math.max(1, (facts.expected_oneline_keywords ?? []).length)) * 100) : null,
    notices: r.notices.map((n) => n.key), think: r.raw.includes("<think>"),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
for (const model of models) {
  const page = await context.newPage();
  await ready(page, `model=${model}`);
  const loaded = await page.evaluate(() => window.__llm.load());
  const st = await page.evaluate(() => window.__llm.stats());
  console.log(`# ${model}: loaded=${loaded} model_id=${st.model_id} load_ms=${st.load_ms} probe_ms=${st.probe_ms}`);
  if (!loaded) { rows.push({ model, error: "load failed" }); await page.close(); continue; }
  for (const doc of docs) for (const level of levels) await runOne(page, model, doc, level, null);
  await page.close();
  if (model === "default") {
    for (const v of variants) {
      const vp = await context.newPage();
      await ready(vp, `model=${model}${v.query}`);
      await vp.evaluate(() => window.__llm.load());
      await runOne(vp, model, v.doc, v.level, v.name);
      await vp.close();
    }
  }
}
await browser.close();
await writeFile(path.join(outDir, `bakeoff-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(rows, null, 2));
console.log(`wrote ${rows.length} rows to bench/last-run/`);
