import { test, expect } from "./model-cache";
import { gotoIsolated } from "./isolated";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// S1-01 proof (docs/PLAN.md): page loads, title from strings, 4 dial options, article has >= 5
// paragraphs, window.__fruitbat.run exists and stats().runs increments after a call, no
// horizontal scroll at 390x844, dark-mode toggle flips data-theme and survives reload.
// Runs on `wasm-ci` (headless bundled Chromium, no WebGPU/LLM needed for the scaffold).
//
// Read with fs + JSON.parse rather than a JSON import: Playwright's own test-file loader (unlike
// Vite/tsc) needs an explicit `type: "json"` import attribute for JSON imports, which is more
// friction than it is worth for two read-only spec files.
const specDir = fileURLToPath(new URL("../../spec/", import.meta.url));
const dialSpec = JSON.parse(readFileSync(specDir + "dial.json", "utf8")) as {
  default: string;
  levels: { id: string; label_key: string }[];
};
const stringsFile = JSON.parse(readFileSync(specDir + "strings/en.json", "utf8")) as { strings: Record<string, string> };

const STRINGS = stringsFile.strings;
const EXPECTED_LEVEL_IDS = dialSpec.levels.map((l) => l.id);

test.describe("web scaffold", () => {
  test("loads with the right title and a 4-option dial", async ({ page }) => {
    await gotoIsolated(page, "/");
    await expect(page).toHaveTitle(STRINGS["app.title"]);

    const radios = page.locator('input[type="radio"][name="level"]');
    await expect(radios).toHaveCount(4);
    const values = await radios.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
    expect(values).toEqual(EXPECTED_LEVEL_IDS);

    const checked = page.locator('input[type="radio"][name="level"]:checked');
    await expect(checked).toHaveCount(1);
    await expect(checked).toHaveValue(dialSpec.default);
  });

  test("renders the sample article as at least 5 paragraphs", async ({ page }) => {
    await gotoIsolated(page, "/");
    const paragraphs = page.locator(".article p");
    await expect(paragraphs).not.toHaveCount(0, { timeout: 15_000 });
    expect(await paragraphs.count()).toBeGreaterThanOrEqual(5);
  });

  test("window.__fruitbat.run exists and stats().runs increments after a call", async ({ page }) => {
    await gotoIsolated(page, "/");
    const before = await page.evaluate(() => window.__fruitbat.stats());
    expect(before.runs).toBe(0);
    expect(before.last).toBeNull();

    await page.evaluate(() => window.__fruitbat.run("hello world", "short"));

    const after = await page.evaluate(() => window.__fruitbat.stats());
    expect(after.runs).toBe(1);
    expect(after.last).toEqual({ level: "short", chars: "hello world".length });
  });

  test("dispatches fruitbat:run and fruitbat:stop events", async ({ page }) => {
    await gotoIsolated(page, "/");
    const seen = await page.evaluate(async () => {
      const runSeen = new Promise<unknown>((resolve) => window.addEventListener("fruitbat:run", (e) => resolve((e as CustomEvent).detail), { once: true }));
      const stopSeen = new Promise<boolean>((resolve) => window.addEventListener("fruitbat:stop", () => resolve(true), { once: true }));
      window.__fruitbat.run("abc", "caveman");
      window.__fruitbat.stop();
      return { run: await runSeen, stop: await stopSeen };
    });
    expect(seen.run).toEqual({ text: "abc", level: "caveman" });
    expect(seen.stop).toBe(true);
  });

  test("no horizontal scroll at 390x844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoIsolated(page, "/");
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
  });

  test("dark-mode toggle flips data-theme and survives reload", async ({ page }) => {
    await gotoIsolated(page, "/");
    const initial = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(initial).toBeNull();

    await page.click(".theme-toggle");
    const afterClick = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(["light", "dark"]).toContain(afterClick);

    await page.reload();
    const afterReload = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(afterReload).toBe(afterClick);
  });
});
