import { test, expect } from "./model-cache";
import type { Page } from "@playwright/test";
import { gotoIsolated } from "./isolated";

// S1-00a proof (docs/PLAN.md): real text -> >= 3 bullets, no <think>, AudioContext running with
// >= 1 s of PCM played, crossOriginIsolated === true. The LLM test runs on `webgpu-local` only;
// `wasm-ci` has no LLM until S1-05's `?llm=fake` worker exists.

const TEXT = `Bats are the only mammals that can truly fly. More than 1,400 species live on every continent except Antarctica, and about 47 of them live in the United States. A single little brown bat can eat up to 1,000 insects in one hour, which is why farmers count on bats to protect crops. Most bats find their way in the dark by echolocation: they send out high-pitched calls and listen for the echoes that bounce back. Fruit bats, also called flying foxes, rely more on their large eyes and strong sense of smell, and they spread the seeds of figs, mangoes, and more than 300 other plants. Since 2006 a fungal disease called white-nose syndrome has killed millions of bats in North America, cutting some colonies by 90 percent. Bats are slow to recover because most females raise only one pup a year. Leaving dead trees standing and turning off outdoor lights are two simple ways people help.`;

test("cross-origin isolation holds via the service worker", async ({ page }) => {
  await gotoIsolated(page, "/skeleton.html");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe("function");
});

test("real text -> real bullets -> real audio", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "webgpu-local", "needs WebGPU; wasm-ci gets ?llm=fake in S1-05");
  await gotoIsolated(page, "/skeleton.html");
  await page.waitForFunction(() => (window as unknown as { __skeleton?: { state: string } }).__skeleton?.state === "idle", null, {
    timeout: 20_000,
  });
  const gpu = await page.evaluate(() => (window as unknown as { __skeleton: { gpu: Record<string, boolean> } }).__skeleton.gpu);
  expect(gpu.device, "WebGPU device available").toBe(true);

  await page.fill("#text", TEXT);
  await page.click("#go");
  await page.waitForFunction(
    () => ["done", "failed"].includes((window as unknown as { __skeleton: { state: string } }).__skeleton.state),
    null,
    { timeout: 9 * 60_000 },
  );
  await page.waitForFunction(() => (window as unknown as { __skeleton: { played(): number } }).__skeleton.played() >= 1, null, {
    timeout: 60_000,
  });
  const s = await page.evaluate(() => {
    const S = (window as unknown as { __skeleton: Record<string, unknown> & { played(): number } }).__skeleton;
    const { played, ...rest } = S;
    return { ...rest, played: played.call(S) } as Record<string, unknown> & { bullets: string[]; raw: string; played: number };
  });
  expect(s.state, String(s.error ?? "")).toBe("done");
  expect(s.bullets.length, JSON.stringify(s.bullets)).toBeGreaterThanOrEqual(3);
  expect(s.raw).not.toContain("<think>");
  expect(s.ctxState).toBe("running");
  expect(s.played).toBeGreaterThanOrEqual(1);
  expect(s.isolated).toBe(true);
  const downloaded = Object.values(s.downloaded as Record<string, number>).reduce((a, b) => a + b, 0);
  testInfo.attach("skeleton-result.json", { body: JSON.stringify({ ...s, downloadedMB: downloaded / 1e6 }, null, 2), contentType: "application/json" });
  // eslint-disable-next-line no-console
  console.log("SKELETON_RESULT " + JSON.stringify({ bullets: s.bullets, timings: s.timings, downloadedMB: Math.round(downloaded / 1e6), audioScheduled: s.audioScheduled, played: s.played, ttsMaxTokens: s.ttsMaxTokens }));
});
