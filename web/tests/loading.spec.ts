import { test, expect } from "./model-cache";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// S1-09 proof (docs/PLAN.md, "Loading UX + canned demo"): route-throttled, ?llm=fake.
//  - no request for the summarizer's pinned files before the first summary click (rule 11: the
//    voice loads on page load; the summarizer waits for a click, real or the explicit button).
//  - the summarizer's size is shown before its download starts.
//  - progress bars (voice, summarizer) are real <progress> elements and reach 100 %.
//  - cache detection renders (first time or already cached).
//  - "Try it now" plays the canned recording within 1 s.
//  - turning the dial switches which recording plays.
//  - navigator.connection.saveData replaces the voice line with the save-data notice.
const specDir = fileURLToPath(new URL("../../spec/", import.meta.url));
const models = JSON.parse(readFileSync(specDir + "models.json", "utf8")) as {
  web: { summarizer: { id: string; files: { bytes: number }[] } };
};
const stringsFile = JSON.parse(readFileSync(specDir + "strings/en.json", "utf8")) as { strings: Record<string, string> };
const STRINGS = stringsFile.strings;
const SUMMARIZER_SIZE_MB = Math.round(models.web.summarizer.files.reduce((n, f) => n + f.bytes, 0) / 1e6);
const SUMMARIZER_ID_FRAGMENT = models.web.summarizer.id.split("/")[1]; // e.g. "Qwen3.5-0.8B-Text-ONNX"

/** Every request to the Hub gets a small fixed delay before continuing ("route-throttled"): real
 *  enough to prove ordering, small enough that the real ~90 MB voice model still loads in a CI
 *  run. `?llm=fake` never makes a real request for the summarizer at all (spec/tools' scripted
 *  worker has no model), so the summarizer-request assertion below is a genuine regression guard
 *  in real mode and vacuously true here -- the size/button/progress-bar assertions are what this
 *  spec actually exercises for the summarizer under CI. */
async function throttleHub(page: Page): Promise<{ urls: string[] }> {
  const urls: string[] = [];
  await page.route("https://huggingface.co/**", async (route) => {
    urls.push(route.request().url());
    await new Promise((r) => setTimeout(r, 60));
    await route.continue();
  });
  return { urls };
}

test.describe("loading UX (?llm=fake, route-throttled)", () => {
  test("summarizer size shown before download; no summarizer request before the click; progress bars reach 100 %; cache detection", async ({ page }) => {
    const { urls } = await throttleHub(page);
    await page.goto("/?llm=fake");
    await page.waitForSelector('[data-testid="loading"]');

    // Voice loads automatically (rule 11); the summarizer must not have been requested yet.
    await page.waitForTimeout(300);
    expect(urls.some((u) => u.includes(SUMMARIZER_ID_FRAGMENT))).toBe(false);

    // Size shown first: the button and the size line exist before any click, with the real MB
    // number from spec/models.json (never a hard-coded UI literal).
    const button = page.getByTestId("summarizer-load");
    await expect(button).toBeVisible();
    await expect(button).toHaveText(new RegExp(`${SUMMARIZER_SIZE_MB} MB`));
    const sizeLine = page.locator(".loading-summarizer .loading-line").first();
    await expect(sizeLine).toHaveText(new RegExp(`${SUMMARIZER_SIZE_MB} MB`));

    await button.click();
    expect(urls.some((u) => u.includes(SUMMARIZER_ID_FRAGMENT)), "?llm=fake never fetches the real summarizer").toBe(false);

    // The summarizer's own bar reaches 100 % (fake mode "downloads" instantly; real mode would
    // reach it once the last byte arrives -- same bar, same assertion).
    const summarizerBar = page.getByTestId("summarizer-progress");
    await expect(summarizerBar).toHaveAttribute("aria-valuenow", "100", { timeout: 20_000 });
    await expect(summarizerBar).toHaveJSProperty("max", 100);
    await expect(summarizerBar).toHaveJSProperty("value", 100);

    // The voice's bar is a real download: poll for either a 100 % frame of it, or the voice line
    // having already moved on to "ready" (the bar is swapped out for the ready line the instant
    // voiceReady flips, so catching the exact 100 % frame is a race either assertion resolves).
    await page.waitForFunction(
      () => {
        const bar = document.querySelector('[data-testid="voice-progress"]') as HTMLProgressElement | null;
        const ready = document.querySelector('[data-phase="ready"]');
        return (bar !== null && bar.value === 100 && bar.max === 100) || ready !== null;
      },
      null,
      { timeout: 300_000 },
    );

    // Cache detection rendered for at least one of the two models (whichever finished loading).
    await expect(page.locator(".loading-cache").first()).toHaveText(new RegExp(`${STRINGS["loading.cached"]}|${STRINGS["loading.first_time"]}`));
  });

  test("saveData: the voice line is replaced, and it never auto-loads", async ({ page, context }) => {
    await context.addInitScript(() => {
      Object.defineProperty(window.navigator, "connection", { value: { saveData: true }, configurable: true });
    });
    await page.goto("/?llm=fake");
    const line = page.locator('[data-phase="save_data"]');
    await expect(line).toHaveText(STRINGS["loading.save_data"]);
    await page.waitForTimeout(500);
    await expect(page.locator('[data-phase="voice"]')).toHaveCount(0);
    await expect(page.locator('[data-phase="ready"]')).toHaveCount(0);
  });
});

test.describe("canned demo (?llm=fake, ?inject=nogpu -- never touches the models)", () => {
  test('"Try it now" plays within 1 s; turning the dial switches the recording', async ({ page }) => {
    await page.goto("/?llm=fake&inject=nogpu");
    const demo = page.getByTestId("demo");
    await expect(demo).toBeVisible();
    await expect(page.getByTestId("demo-audio")).toHaveAttribute("src", "/demo/short.wav", { timeout: 15_000 });

    const ms = await page.evaluate(async () => {
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="demo-try"]')!;
      const audio = document.querySelector<HTMLAudioElement>('[data-testid="demo-audio"]')!;
      const t0 = performance.now();
      btn.click();
      await new Promise<void>((resolve) => {
        const check = () => {
          if (audio.currentTime > 0 && !audio.paused) resolve();
          else requestAnimationFrame(check);
        };
        check();
      });
      return performance.now() - t0;
    });
    expect(ms).toBeLessThan(1000);

    // The recording is labeled as one, and it is the sample article's own text (spot-checked),
    // never a live model output.
    await expect(page.locator(".demo-recording-label")).toHaveText(STRINGS["demo.recording_label"]);
    const firstBullet = await page.locator('[data-testid="demo-bullets"] li').first().textContent();
    expect(firstBullet).toContain("bat");

    // Turning the dial (the header's, shared with the demo per state/level.ts) switches the file.
    await page.locator('input[type="radio"][name="level"][value="caveman"]').click();
    await expect(page.getByTestId("demo-audio")).toHaveAttribute("src", "/demo/caveman.wav", { timeout: 15_000 });
    const cavemanBullet = await page.locator('[data-testid="demo-bullets"] li').first().textContent();
    expect(cavemanBullet).not.toBe(firstBullet);
  });
});
