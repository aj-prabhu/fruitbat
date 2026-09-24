import { test, expect, type Page, type Browser } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// S1-06 proof (docs/PLAN.md): the orchestrator on the real app at `/`, with the scripted
// summarizer (`?llm=fake`, C5) and the real voice (Kokoro q8 on WASM). Delayed completion after
// stop is dropped; a dial change regenerates the chunk under the playback cursor and speaks the
// notice ≤ 500 ms; rapid re-select runs the latest only; Esc ≤ 200 ms mid-generation; the stats
// row has a ttfa; an all-cut chunk offers "Read this part" and never auto-plays; the input
// limit is spoken. One page per flag set; the voice is cached after the first load.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC011 = readFileSync(path.join(ROOT, "spec/eval/corpus/011.txt"), "utf8");
const DOC005 = readFileSync(path.join(ROOT, "spec/eval/corpus/005.txt"), "utf8");
const DOC025 = readFileSync(path.join(ROOT, "spec/eval/corpus/025.txt"), "utf8");
const P011 = DOC011.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

type Snap = {
  gen: string;
  play: string;
  level: string;
  runId: number;
  bullets: { text: string; chunkIndex: number }[];
  current: { kind: "bullet"; chunkIndex: number; index: number } | { kind: "sentence"; start: number; text: string; next: string | null } | null;
  allCut: number[];
  notices: string[];
  lastNotice: string | null;
  chunks: number;
  voiceReady: boolean;
  prewarmed: boolean;
  voice: { aheadSeconds: number; enqueued: number; inFlight: number; ended: number; phase: string };
};
type Stats = { runs: number; last: { level: string; chars: number } | null; ttfa_ms: number | null; stop_ms: number | null; notice_latency_ms: number | null; notices_spoken: string[]; gen: { level_used: string | null; ttfa_ms: number | null; chunks: number } };
type Api = { run(t: string, l: string): void; stop(): void; stats(): Stats; state(): Snap; setLevel(l: string): Promise<void>; readThisPart(i: number): Promise<void> };
type W = { __fruitbat: Api };

const snap = (page: Page) => page.evaluate(() => (window as unknown as W).__fruitbat.state());
const stats = (page: Page) => page.evaluate(() => (window as unknown as W).__fruitbat.stats());
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

async function open(page: Page, query: string) {
  await page.goto(`/${query}`);
  for (let i = 0; i < 3; i++) {
    try {
      await page.waitForFunction(() => crossOriginIsolated === true, null, { timeout: 15_000 });
      break;
    } catch {
      await page.waitForLoadState("load");
    }
  }
  await page.waitForFunction(() => typeof (window as unknown as Partial<W>).__fruitbat?.state === "function", null, { timeout: 20_000 });
  // The voice loads on page load (rule 11) and prewarms the fixed notices; the dial notice
  // latency is measured against a warm voice, as in the product.
  await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().prewarmed, null, { timeout: 300_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("orchestrator on the real app (?llm=fake)", () => {
  let page: Page;
  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    page = await browser.newPage();
    await open(page, "?llm=fake&delay=40");
  });
  test.afterAll(async () => {
    await page?.close();
  });

  test("delayed completion after stop is dropped; stop ≤ 200 ms", async () => {
    await page.evaluate((t) => (window as unknown as W).__fruitbat.run(t, "short"), P011.slice(0, 3).join("\n\n"));
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().bullets.length >= 1, null, { timeout: 60_000 });
    const r = await page.evaluate(async () => {
      const before = (window as unknown as W).__fruitbat.state().bullets.length;
      (window as unknown as W).__fruitbat.stop();
      const s0 = (window as unknown as W).__fruitbat.state();
      await new Promise((r) => setTimeout(r, 3000)); // the fake keeps streaming for ~4 s per chunk
      const s1 = (window as unknown as W).__fruitbat.state();
      return { before, s0, s1, stats: (window as unknown as W).__fruitbat.stats() };
    });
    expect(r.s0.gen).toBe("idle");
    expect(r.s0.play).toBe("stopped");
    expect(r.s1.bullets.length, "no bullet after stop").toBe(r.before);
    expect(r.s1.gen).toBe("idle");
    expect(r.s1.play).toBe("stopped");
    expect(r.s1.current).toBeNull();
    expect(r.s1.voice.aheadSeconds).toBe(0);
    expect(r.stats.stop_ms).not.toBeNull();
    expect(r.stats.stop_ms as number).toBeLessThanOrEqual(200);
    expect(r.s1.notices).toContain("notice.stopped");
    console.log(`DIAL_STOP stop_ms=${r.stats.stop_ms} bullets_before=${r.before}`);
  });

  test("dial change regenerates the chunk under the playback cursor and speaks the notice ≤ 500 ms", async () => {
    await page.evaluate((t) => (window as unknown as W).__fruitbat.run(t, "short"), DOC011);
    // Chunk 1 bullets exist while chunk 0 is still playing: the cursor decides where to restart.
    await page.waitForFunction(
      () => {
        const s = (window as unknown as W).__fruitbat.state();
        return s.chunks >= 2 && s.bullets.some((b) => b.chunkIndex === 1) && s.current?.kind === "bullet" && s.play === "playing";
      },
      null,
      { timeout: 120_000 },
    );
    const before = await snap(page);
    const cursorChunk = before.current?.kind === "bullet" ? before.current.chunkIndex : -1;
    await page.evaluate(() => {
      void (window as unknown as W).__fruitbat.setLevel("caveman");
    });
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.stats().notice_latency_ms !== null, null, { timeout: 10_000 });
    const latency = (await stats(page)).notice_latency_ms as number;
    console.log(`DIAL_NOTICE latency_ms=${latency} cursor_chunk=${cursorChunk}`);
    expect(latency).toBeLessThanOrEqual(500);
    expect((await snap(page)).notices).toContain("notice.dial_shorter");
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().gen === "done", null, { timeout: 120_000 });
    const after = await snap(page);
    const st = await stats(page);
    expect(after.level).toBe("caveman");
    expect(st.gen.level_used).toBe("caveman");
    expect(after.bullets.length).toBeGreaterThan(0);
    expect(after.bullets[0].chunkIndex, "regeneration starts at the chunk under the cursor").toBe(cursorChunk);
    expect(after.bullets.every((b) => b.chunkIndex >= cursorChunk)).toBe(true);
    expect(after.bullets.every((b) => words(b.text) <= 9), "caveman bullets").toBe(true);
    // Adding detail: the notice for the other direction.
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().play === "playing", null, { timeout: 60_000 });
    await page.evaluate(() => {
      void (window as unknown as W).__fruitbat.setLevel("short");
    });
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().notices.includes("notice.dial_longer"), null, { timeout: 10_000 });
    await page.evaluate(() => (window as unknown as W).__fruitbat.stop());
  });

  test("rapid re-select: only the latest input runs", async () => {
    const runsBefore = (await stats(page)).runs;
    await page.evaluate(
      ([a, b]) => {
        (window as unknown as W).__fruitbat.run(a, "short");
        (window as unknown as W).__fruitbat.run(b, "short");
      },
      [DOC005, P011[0]] as const,
    );
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().gen === "done", null, { timeout: 60_000 });
    const s = await snap(page);
    const st = await stats(page);
    expect(st.runs).toBe(runsBefore + 2);
    expect(st.last?.chars).toBe(P011[0].length);
    expect(s.bullets.length).toBeGreaterThan(0);
    expect(s.bullets.some((b) => /Alice|Carla|Dev/.test(b.text)), "no bullet from the superseded input").toBe(false);
    await page.evaluate(() => (window as unknown as W).__fruitbat.stop());
  });

  test("Esc ≤ 200 ms mid-generation", async () => {
    // 025 is 10 chunks: generation is still going when the first audio plays, so Esc lands
    // mid-generation (011's 2 chunks finish generating before the first synthesis ends).
    await page.evaluate((t) => (window as unknown as W).__fruitbat.run(t, "short"), DOC025);
    await page.waitForFunction(() => {
      const s = (window as unknown as W).__fruitbat.state();
      return s.gen === "running" && s.play === "playing";
    }, null, { timeout: 120_000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => {
      const s = (window as unknown as W).__fruitbat.state();
      return s.gen === "idle" && s.play === "stopped";
    }, null, { timeout: 5_000 });
    const st = await stats(page);
    const s = await snap(page);
    console.log(`DIAL_ESC stop_ms=${st.stop_ms}`);
    expect(st.stop_ms as number).toBeLessThanOrEqual(200);
    expect(s.voice.aheadSeconds).toBe(0);
    expect(s.current).toBeNull();
  });

  test("a finished run writes a stats row with a ttfa", async () => {
    await page.evaluate((t) => (window as unknown as W).__fruitbat.run(t, "short"), P011[0]);
    await page.waitForFunction(() => {
      const s = (window as unknown as W).__fruitbat.state();
      return s.gen === "done" && s.play === "idle" && s.voice.ended > 0;
    }, null, { timeout: 180_000 });
    const st = await stats(page);
    console.log(`DIAL_STATS ttfa_ms=${st.ttfa_ms} gen_ttfa_ms=${st.gen.ttfa_ms} chunks=${st.gen.chunks}`);
    expect(st.ttfa_ms).not.toBeNull();
    expect(st.ttfa_ms as number).toBeGreaterThan(0);
    expect(st.gen.ttfa_ms).not.toBeNull();
    expect((await snap(page)).notices).toContain("notice.done");
  });
});

test.describe("all-cut chunk (?llm=fake&fake=cutshort)", () => {
  test("is announced, offers Read this part, and never auto-plays", async ({ page }) => {
    await open(page, "?llm=fake&fake=cutshort");
    await page.evaluate((t) => (window as unknown as W).__fruitbat.run(t, "short"), P011[0]);
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().gen === "done", null, { timeout: 60_000 });
    const s = await snap(page);
    expect(s.allCut).toEqual([0]);
    expect(s.notices).toContain("notice.all_cut");
    expect((await stats(page)).notices_spoken).toContain("notice.all_cut");
    expect(s.bullets.length).toBe(0);
    expect(s.voice.enqueued, "nothing auto-played").toBe(0);
    expect(s.play).toBe("idle");
    const button = page.locator("button.read-part[data-chunk='0']");
    await expect(button).toBeVisible();
    await button.click();
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().play === "playing", null, { timeout: 60_000 });
    const after = await snap(page);
    expect(after.voice.enqueued).toBeGreaterThan(0);
    expect(after.current?.kind).toBe("sentence");
    await page.evaluate(() => (window as unknown as W).__fruitbat.stop());
  });
});

test.describe("input limit (?llm=fake&chunk=20)", () => {
  test("is shown and spoken", async ({ page }) => {
    await open(page, "?llm=fake&chunk=20");
    await page.evaluate((t) => (window as unknown as W).__fruitbat.run(t, "short"), DOC011);
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().gen === "failed", null, { timeout: 60_000 });
    const s = await snap(page);
    expect(s.notices).toContain("notice.input_limit");
    expect((await stats(page)).notices_spoken).toContain("notice.input_limit");
    expect(s.bullets.length).toBe(0);
    await expect(page.locator(".panel-notice[data-notice='notice.input_limit']")).toBeVisible();
  });
});
