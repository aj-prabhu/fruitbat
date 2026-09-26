import { test, expect, type Page } from "@playwright/test";
import { gotoIsolated } from "./isolated";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// S1-05 proof (docs/PLAN.md): webgpu-local runs the real summarizer (>= 1 bullet per chunk, no
// <think>, fault injection, no model bytes before the first summary request); wasm-ci runs the
// scripted worker (?llm=fake): streaming, abort honored, One line + reduce, One line failure ->
// Short. Every wasm-ci case names ?llm=fake (C5).

const corpus = (id: string) => readFileSync(path.resolve(here, "../../spec/eval/corpus", `${id}.txt`), "utf8");
const DOC011 = corpus("011");
const DOC025 = corpus("025");

type Result = { bullets: { text: string; chunkIndex: number }[]; notices: { key: string }[]; raw: string; stats: Record<string, unknown> & { chunks: number; per_chunk_kept: number[]; level_used: string; reduce_calls: number }; state: string; error: string | null; aborted: boolean };

async function open(page: Page, query: string) {
  await gotoIsolated(page, `/summarize.html${query}`);
  await page.waitForFunction(() => (window as unknown as { __llm?: { state(): { ready: boolean } } }).__llm?.state().ready === true, null, { timeout: 20_000 });
}
const summarize = (page: Page, text: string, level: string) =>
  page.evaluate(([t, l]) => (window as unknown as { __llm: { summarize(t: string, l: string): Promise<Result> } }).__llm.summarize(t, l), [text, level] as const);

test.describe("real summarizer (webgpu-local)", () => {

  test("cold load: nothing downloads before the first summary request; 011 gets >= 1 bullet per chunk, no <think>", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "webgpu-local", "needs WebGPU");
    await open(page, "");
    const before = await page.evaluate(() => (window as unknown as { __llm: { requests(): number; probe(): Promise<{ ok: boolean }> } }).__llm.requests());
    expect(before, "model files requested on load").toBe(0);
    const gpu = await page.evaluate(() => (window as unknown as { __llm: { probe(): Promise<{ ok: boolean }> } }).__llm.probe());
    expect(gpu.ok).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __llm: { requests(): number } }).__llm.requests()), "probe must not download").toBe(0);
    const r = await summarize(page, DOC011, "short");
    expect(r.state, r.error ?? "").toBe("done");
    expect(r.stats.chunks).toBe(2);
    expect(r.stats.per_chunk_kept.every((k) => k >= 1), JSON.stringify(r.stats.per_chunk_kept)).toBe(true);
    expect(r.raw).not.toContain("<think>");
    expect(await page.evaluate(() => (window as unknown as { __llm: { requests(): number } }).__llm.requests())).toBeGreaterThan(0);
    console.log("REAL_SHORT_011 " + JSON.stringify({ bullets: r.bullets.map((b) => b.text), stats: r.stats }));
  });

  test("?inject=nogpu -> llm failed, Read all unaffected", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "webgpu-local", "needs WebGPU");
    await open(page, "?inject=nogpu");
    const loaded = await page.evaluate(() => (window as unknown as { __llm: { load(): Promise<boolean> } }).__llm.load());
    expect(loaded).toBe(false);
    const st = await page.evaluate(() => (window as unknown as { __llm: { state(): { state: string; error: string } } }).__llm.state());
    expect(st.state).toBe("failed");
    expect(st.error).toContain("nogpu");
    const notices = await page.evaluate(() => (window as unknown as { __llm: { notices(): { key: string }[] } }).__llm.notices());
    expect(notices.map((n) => n.key)).toContain("notice.no_webgpu");
    expect(await page.evaluate(() => (window as unknown as { __llm: { requests(): number } }).__llm.requests())).toBe(0);
  });

  test("?inject=devicelost -> post-download probe fails cleanly", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "webgpu-local", "needs WebGPU");
    await open(page, "?inject=devicelost");
    const loaded = await page.evaluate(() => (window as unknown as { __llm: { load(): Promise<boolean> } }).__llm.load());
    expect(loaded).toBe(false);
    const st = await page.evaluate(() => (window as unknown as { __llm: { state(): { state: string; error: string } } }).__llm.state());
    expect(st.state).toBe("failed");
    expect(st.error).toMatch(/probe:.*DeviceLost/);
    const notices = await page.evaluate(() => (window as unknown as { __llm: { notices(): { key: string }[] } }).__llm.notices());
    expect(notices.map((n) => n.key)).toContain("notice.probe_failed");
  });

  test("?inject=oom -> low-end tier takes over and still summarizes", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "webgpu-local", "needs WebGPU");
    await open(page, "?inject=oom");
    const r = await summarize(page, DOC011, "caveman");
    expect(r.state, r.error ?? "").toBe("done");
    expect(r.stats.downgraded).toBe(true);
    expect(r.stats.role).toBe("low-end");
    expect(r.notices.map((n) => n.key)).toContain("notice.low_end_tier");
    expect(r.bullets.length).toBeGreaterThanOrEqual(1);
    console.log("OOM_LOWEND_011 " + JSON.stringify({ bullets: r.bullets.map((b) => b.text), stats: r.stats }));
  });
});

test.describe("fake summarizer (wasm-ci, ?llm=fake)", () => {
  test("bullets stream per chunk; One line reduces to a single final line", async ({ page }) => {
    await open(page, "?llm=fake");
    const s = await summarize(page, DOC025, "short");
    expect(s.state).toBe("done");
    expect(s.stats.chunks).toBeGreaterThan(1);
    expect(s.bullets.length).toBeGreaterThanOrEqual(s.stats.chunks);
    expect(s.stats.per_chunk_kept.every((k) => k >= 1)).toBe(true);
    const o = await summarize(page, DOC025, "oneline");
    expect(o.state).toBe("done");
    expect(o.bullets.length).toBe(1);
    expect(o.bullets[0].chunkIndex).toBe(-1);
    expect(o.stats.reduce_calls).toBeGreaterThanOrEqual(1);
    expect(o.stats.level_used).toBe("oneline");
    // Every chunk line and every reduce line counts toward bullets_total (the fake always answers).
    expect(o.stats.bullets_total).toBe(o.stats.chunks + o.stats.reduce_calls);
  });

  test("abort mid-stream is honored: no bullets after abort, worker acknowledges", async ({ page }) => {
    await open(page, "?llm=fake&delay=40");
    const done = page.evaluate(() => {
      const w = window as unknown as { __llm: { summarize(t: string, l: string): Promise<Result>; bullets(): unknown[]; abort(): void } };
      return w.__llm.summarize(Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} says that the bat colony counted ${i + 100} animals tonight.`).join(" "), "short");
    });
    await page.waitForFunction(() => (window as unknown as { __llm: { bullets(): unknown[] } }).__llm.bullets().length >= 1, null, { timeout: 15_000 });
    const atAbort = await page.evaluate(() => {
      const w = window as unknown as { __llm: { bullets(): unknown[]; abort(): void } };
      const n = w.__llm.bullets().length;
      w.__llm.abort();
      return n;
    });
    const r = await done;
    expect(r.aborted).toBe(true);
    expect(r.state).toBe("stopped");
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => (window as unknown as { __llm: { bullets(): unknown[] } }).__llm.bullets().length);
    expect(after).toBe(atAbort);
  });

  test("Stop then an immediate new summary: the next run waits for the worker, then runs clean", async ({ page }) => {
    await open(page, "?llm=fake&delay=40");
    const r = await page.evaluate(async () => {
      type Api = { summarize(t: string, l: string): Promise<Result>; bullets(): { text: string }[]; abort(): void };
      const w = window as unknown as { __llm: Api };
      const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} says that the bat colony counted ${i + 100} animals tonight.`).join(" ");
      const first = w.__llm.summarize(long, "short");
      await new Promise<void>((res) => {
        const t = setInterval(() => {
          if (w.__llm.bullets().length >= 1) {
            clearInterval(t);
            res();
          }
        }, 10);
      });
      w.__llm.abort();
      const a = await first;
      const b = await w.__llm.summarize("The fruit bat colony roosts in the old fig tree. It leaves at dusk to feed on ripe figs.", "short");
      return { a: a.state, b };
    });
    expect(r.a).toBe("stopped");
    expect(r.b.state).toBe("done");
    expect(r.b.bullets.length).toBeGreaterThanOrEqual(1);
    expect(r.b.bullets.every((x) => !/Sentence number/.test(x.text))).toBe(true);
  });

  test("One line falls back to Short when more than half the chunks are cut", async ({ page }) => {
    await open(page, "?llm=fake&fake=cutall");
    const r = await summarize(page, DOC025, "oneline");
    expect(r.state).toBe("done");
    expect(r.notices.map((n) => n.key)).toContain("notice.oneline_failed");
    expect(r.stats.level_used).toBe("short");
    expect(r.bullets.length).toBeGreaterThanOrEqual(1);
    expect(r.bullets.every((b) => b.chunkIndex >= 0)).toBe(true);
  });

  test("a stray <think> block is stripped and fixture bullets pass grounding", async ({ page }) => {
    await open(page, "?llm=fake&fake=think");
    const r = await summarize(page, DOC011, "short");
    expect(r.state).toBe("done");
    expect(r.raw).toContain("<think>");
    expect(r.bullets.map((b) => b.text)).toEqual(["The park hosts 17 different bat species.", "They fly about 1.5 miles before exiting the Natural Entrance."]);
  });

  test("input limit: over 100 chunks refuses with the spoken notice", async ({ page }) => {
    await open(page, "?llm=fake&chunk=40");
    const r = await summarize(page, DOC025, "short");
    expect(r.state).toBe("failed");
    expect(r.error).toBe("input_limit");
    expect(r.notices.map((n) => n.key)).toContain("notice.input_limit");
    expect(r.bullets.length).toBe(0);
  });
});
