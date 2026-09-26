import { test, expect, type Page, type Browser } from "@playwright/test";
import { gotoIsolated } from "./isolated";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// S1-04 proof (docs/PLAN.md): Read all through the TTS worker + bounded queue. Coverage on doc
// 020 (offsets tile), duration additivity on 020 within 10 %, tts_overlimit = 0, rate change
// audible as a duration change, stop <= 200 ms, spoken message produces PCM, and a RunStats row.
// One page and one voice load for the whole file (the model is 92 MB).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC020 = readFileSync(path.join(ROOT, "spec/eval/corpus/020.txt"), "utf8");
const DOC011 = readFileSync(path.join(ROOT, "spec/eval/corpus/011.txt"), "utf8");
const PARAGRAPHS_011 = DOC011.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
// Additivity input: the first 120 words of doc 020 as ONE paragraph. 020 has no sentence
// punctuation, so the segmenter sees one long sentence (~600 phonemes) that the TTS-safe rule
// must split; at target 300 it becomes ~3 pieces, at target 500 ~2 pieces.
const EXCERPT_020 = DOC020.split(/\s+/).slice(0, 120).join(" ");
const SENTENCE = "Bats are the only mammals that can truly fly, and more than 1,400 species live on every continent except Antarctica.";

type Tts = {
  load(): Promise<{ maxTokens: number; downloadedBytes: number; isolated: boolean; threads: number | null; cores: number; warmupMs: number }>;
  plan(text: string): Promise<{ segments: { seq: number; start: number; end: number; text: string; phonemes: string }[]; maxPhonemes: number; splitMs: number }>;
  measure(text: string, target: number, rate?: number): Promise<{ seconds: number; pieces: number; synthMs: number; maxPhonemes: number }>;
  readAll(text: string, opts?: { rate?: number }): Promise<{ runId: number; segments: number; coverage: number; ttsOverlimit: number; seconds: number; finished: boolean }>;
  speak(key: string): Promise<{ seconds: number }>;
  stop(): number;
  state(): { phase: string; error: string | null; playing: unknown; aheadSeconds: number; inFlight: number; enqueued: number; ended: number; ctxState: string };
  stats(): Record<string, unknown> | null;
};
declare global {
  interface Window {
    __tts: Tts;
  }
}

test.describe.configure({ mode: "serial" });

let page: Page;
let clockAdvances = false;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  page = await browser.newPage();
  await gotoIsolated(page, "/readall.html");
  await page.waitForFunction(() => typeof window.__tts !== "undefined", null, { timeout: 20_000 });
  const loaded = await page.evaluate(() => window.__tts.load());
  expect(loaded.maxTokens).toBe(512);
  console.log(`READALL_LOADED isolated=${loaded.isolated} threads=${loaded.threads} cores=${loaded.cores} warmupMs=${loaded.warmupMs} downloadedMB=${Math.round(loaded.downloadedBytes / 1e6)}`);
  // Does this browser's AudioContext clock advance without a real output device?
  clockAdvances = await page.evaluate(async () => {
    const ctx = new AudioContext({ sampleRate: 24000 });
    await ctx.resume();
    const t0 = ctx.currentTime;
    await new Promise((r) => setTimeout(r, 400));
    const advanced = ctx.currentTime - t0 > 0.1;
    await ctx.close();
    return advanced;
  });
  console.log(`READALL_CLOCK advances=${clockAdvances}`);
});

test.afterAll(async () => {
  await page?.close();
});

test("coverage: TTS-safe segments tile doc 020 and none exceeds the limit", async () => {
  const plan = await page.evaluate((text) => window.__tts.plan(text), DOC020);
  expect(plan.segments.length).toBeGreaterThan(20); // 41 with clause packing (was 89 when every comma split)
  expect(plan.maxPhonemes).toBeLessThanOrEqual(510);
  let prevEnd = 0;
  for (const s of plan.segments) {
    expect(s.start).toBeGreaterThanOrEqual(prevEnd);
    expect(DOC020.slice(prevEnd, s.start).trim()).toBe("");
    expect(DOC020.slice(s.start, s.end)).toBe(s.text);
    expect(s.phonemes.length).toBeLessThanOrEqual(510);
    prevEnd = s.end;
  }
  expect(DOC020.slice(prevEnd).trim()).toBe("");
  console.log(`READALL_COVERAGE segments=${plan.segments.length} maxPhonemes=${plan.maxPhonemes} splitMs=${Math.round(plan.splitMs)}`);
});

test("additivity: segment durations on a 020 excerpt match larger pieces within 10 %", async () => {
  // Definition: the same text synthesized as TTS-safe segments (target 300 phonemes) and as
  // larger pieces (target 500, still under the 510 limit); total audio seconds must agree within 10 %.
  const small = await page.evaluate((t) => window.__tts.measure(t, 300), EXCERPT_020);
  const large = await page.evaluate((t) => window.__tts.measure(t, 500), EXCERPT_020);
  expect(small.pieces).toBeGreaterThan(large.pieces);
  expect(small.seconds).toBeGreaterThan(20);
  const rel = Math.abs(small.seconds - large.seconds) / large.seconds;
  console.log(`READALL_ADDITIVITY small=${small.seconds.toFixed(2)}s/${small.pieces} large=${large.seconds.toFixed(2)}s/${large.pieces} rel=${(rel * 100).toFixed(1)}%`);
  expect(rel).toBeLessThanOrEqual(0.1);
});

test("rate: 1.5 is audibly shorter than 1.0", async () => {
  const slow = await page.evaluate((t) => window.__tts.measure(t, 300, 1.0), SENTENCE);
  const fast = await page.evaluate((t) => window.__tts.measure(t, 300, 1.5), SENTENCE);
  console.log(`READALL_RATE 1.0=${slow.seconds.toFixed(2)}s 1.5=${fast.seconds.toFixed(2)}s`);
  expect(fast.seconds).toBeLessThan(slow.seconds * 0.8);
});

test("speak(messageKey) produces PCM for a spoken panel message", async () => {
  const r = await page.evaluate(() => window.__tts.speak("notice.stopped"));
  expect(r.seconds).toBeGreaterThan(0.2);
});

test("stop within 200 ms while reading", async () => {
  const text = PARAGRAPHS_011.slice(0, 2).join("\n\n");
  await page.evaluate((t) => {
    void window.__tts.readAll(t);
  }, text);
  await page.waitForFunction(
    (adv) => {
      const s = window.__tts.state();
      return adv ? s.playing !== null : s.enqueued > 0;
    },
    clockAdvances,
    { timeout: 120_000 },
  );
  const r = await page.evaluate(() => {
    const ms = window.__tts.stop();
    const s = window.__tts.state();
    return { ms, phase: s.phase, playing: s.playing, ahead: s.aheadSeconds };
  });
  console.log(`READALL_STOP ms=${r.ms.toFixed(2)} phase=${r.phase}`);
  expect(r.ms).toBeLessThanOrEqual(200);
  expect(r.phase).toBe("stopped");
  expect(r.playing).toBeNull();
  expect(r.ahead).toBe(0);
});

test("a second Read all replaces the first and settles it (Codex review, PR #17)", async () => {
  const text = PARAGRAPHS_011.slice(0, 2).join("\n\n");
  await page.evaluate((t) => {
    (window as unknown as { __first: Promise<{ finished: boolean }> }).__first = window.__tts.readAll(t);
  }, text);
  await page.waitForFunction(() => window.__tts.state().enqueued > 0, null, { timeout: 120_000 });
  const first = await page.evaluate(async (t) => {
    void window.__tts.readAll(t);
    const r = await Promise.race([
      (window as unknown as { __first: Promise<{ finished: boolean }> }).__first,
      new Promise<null>((res) => setTimeout(() => res(null), 5_000)),
    ]);
    window.__tts.stop();
    return r;
  }, PARAGRAPHS_011[0]);
  expect(first).not.toBeNull();
  expect(first!.finished).toBe(false);
});

test("stop during planning settles readAll; stop cancels a pending spoken message (Codex review, PR #17)", async () => {
  // 020 is one long unpunctuated paragraph: planning phonemizes it for a couple of seconds, so a
  // stop() issued right after readAll() lands while the worker is still planning.
  const r = await page.evaluate(async (t) => {
    const p = window.__tts.readAll(t);
    await new Promise((r) => setTimeout(r, 30));
    const phaseAtStop = window.__tts.state().phase;
    const ms = window.__tts.stop();
    const res = await Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), 20_000))]);
    const s = window.__tts.state();
    return { phaseAtStop, ms, res, phase: s.phase, enqueued: s.enqueued };
  }, DOC020);
  expect(r.phaseAtStop).toBe("planning");
  expect(r.res).not.toBe("hung");
  expect((r.res as { finished: boolean }).finished).toBe(false);
  expect(r.phase).toBe("stopped");
  expect(r.enqueued).toBe(0);

  const m = await page.evaluate(async () => {
    const p = window.__tts.speak("notice.oneline_failed");
    await new Promise((r) => setTimeout(r, 20));
    window.__tts.stop();
    const res = await Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), 20_000))]);
    return res;
  });
  expect(m).not.toBe("hung");
  expect((m as { seconds: number }).seconds).toBe(0);
});

test("read all to the end writes a RunStats row", async ({}, testInfo) => {
  const text = PARAGRAPHS_011[0];
  const result = await page.evaluate(
    async ({ t, adv }) => {
      const p = window.__tts.readAll(t);
      if (adv) return await p;
      // Headless without an output: the clock does not advance, so playback never "ends".
      // Wait for every segment to be synthesized and scheduled instead (the directive's fallback).
      const start = Date.now();
      for (;;) {
        const s = window.__tts.state();
        if (s.phase === "failed") throw new Error(s.error ?? "failed");
        if (s.enqueued > 0 && s.inFlight === 0 && s.phase === "reading" && Date.now() - start > 2000) break;
        if (Date.now() - start > 240_000) throw new Error("timeout");
        await new Promise((r) => setTimeout(r, 200));
      }
      window.__tts.stop();
      return { ...(await p), scheduledOnly: true };
    },
    { t: text, adv: clockAdvances },
  );
  // stop() on a finished run still measures the stop path; the row records it (stop_ms).
  const stopMs = await page.evaluate(() => window.__tts.stop());
  const stats = await page.evaluate(() => window.__tts.stats());
  console.log("READALL_STATS " + JSON.stringify({ ...stats, result, stopMs }));
  testInfo.attach("run-stats.json", { body: JSON.stringify({ stats, result }, null, 2), contentType: "application/json" });
  expect(stats).not.toBeNull();
  expect(result.coverage).toBe(1);
  expect(result.ttsOverlimit).toBe(0);
  expect(stats!.tts_overlimit).toBe(0);
  expect(stats!.coverage).toBe(1);
  expect(stats!.level).toBe("readall");
  if (clockAdvances) {
    expect(result.finished).toBe(true);
    expect(stats!.ttfa_ms as number).toBeGreaterThan(0);
    expect(stats!.rtf as number).toBeGreaterThan(0);
  }
  if (testInfo.project.name === "webgpu-local") {
    expect(stats!.rtf as number).toBeGreaterThanOrEqual(1.0);
    expect(stats!.stop_ms as number).toBeLessThanOrEqual(200);
  }
});
