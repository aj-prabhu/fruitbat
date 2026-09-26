// S1-06 timing run on the real app: 011 at Short with the real summarizer (WebGPU) and the voice.
//   node scripts/real-run.mjs http://localhost:4195 [?tts=webgpu]
// Prints the orchestrator's stats row (ttfa, stop, notice latency, gen tok/s, voice rtf/gap).
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2];
const query = process.argv[3] ?? "";
if (!base) throw new Error("usage: node scripts/real-run.mjs <baseUrl> [query]");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC011 = readFileSync(path.join(ROOT, "spec/eval/corpus/011.txt"), "utf8");

const browser = await chromium.launch({ headless: false, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const page = await browser.newPage();
await page.goto(`${base}/${query}`);
for (let i = 0; i < 3; i++) {
  try {
    await page.waitForFunction(() => crossOriginIsolated === true, null, { timeout: 15_000 });
    break;
  } catch {
    await page.waitForLoadState("load");
  }
}
await page.waitForFunction(() => window.__fruitbat?.state?.().prewarmed, null, { timeout: 300_000 });
const t0 = Date.now();
await page.evaluate((t) => window.__fruitbat.run(t, "short"), DOC011);
await page.waitForFunction(() => {
  const s = window.__fruitbat.state();
  // Speech still on its way (loading, phonemizing, synthesizing or scheduled) is part of the run
  // (Codex review, PR #18).
  const voiceIdle = s.voice.pending === 0 && s.voice.inFlight === 0 && s.voice.enqueued <= s.voice.ended;
  return (s.gen === "done" || s.gen === "failed") && (s.play === "idle" || s.play === "stopped" || s.gen === "failed") && (voiceIdle || s.gen === "failed");
}, null, { timeout: 600_000 });
const s = await page.evaluate(() => window.__fruitbat.state());
const st = await page.evaluate(() => window.__fruitbat.stats());
await browser.close();
console.log(
  "REAL_RUN " +
    JSON.stringify({
      query,
      wall_ms: Date.now() - t0,
      gen: s.gen,
      play: s.play,
      bullets: s.bullets.length,
      chunks: s.chunks,
      allCut: s.allCut,
      notices: s.notices,
      ttfa_ms: st.ttfa_ms,
      gen_stats: { ttfa_ms: st.gen.ttfa_ms, tok_s: st.gen.tok_s, load_ms: st.gen.load_ms, chunks: st.gen.chunks, bullets_total: st.gen.bullets_total, bullets_cut: st.gen.bullets_cut, model: st.gen.model_id },
      voice_run: st.voice_run,
      bullet_texts: s.bullets.map((b) => b.text),
    }),
);
