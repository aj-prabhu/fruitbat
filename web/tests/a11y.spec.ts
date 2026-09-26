import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// S1-07 proof (docs/PLAN.md "Accessibility"): axe finds 0 serious/critical violations on `/` in
// light and dark, with the panel populated by a `?llm=fake` Short run (bullets, the rate slider,
// voice/speak controls, the text-size/spacing steps -- everything S1-07 added). wcag2a/2aa/21aa
// covers contrast (1.4.3), name/role/value, and keyboard-operability rules; axe's color-contrast
// rule checks text only, so it exercises every color pairing this packet introduced.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC011 = readFileSync(path.join(ROOT, "spec/eval/corpus/011.txt"), "utf8");

type W = { __fruitbat: { run(t: string, l: string): void; state(): { bullets: unknown[]; prewarmed: boolean } } };

async function openPopulated(page: Page): Promise<void> {
  await page.goto("/?llm=fake&delay=40");
  for (let i = 0; i < 3; i++) {
    try {
      await page.waitForFunction(() => crossOriginIsolated === true, null, { timeout: 15_000 });
      break;
    } catch {
      await page.waitForLoadState("load");
    }
  }
  await page.waitForFunction(() => typeof (window as unknown as Partial<W>).__fruitbat?.state === "function", null, { timeout: 20_000 });
  await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().prewarmed, null, { timeout: 300_000 });
  await page.evaluate((t) => (window as unknown as W).__fruitbat.run(t, "short"), DOC011);
  await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().bullets.length >= 1, null, { timeout: 60_000 });
}

async function seriousOrCritical(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

test.describe.configure({ mode: "serial" });

// One page for both checks (as dial.spec.ts does): the voice model only has to load once, and the
// dark check reuses the exact same populated panel the light check just verified, toggled in
// place -- the most direct way to prove the *same* markup passes in both themes.
test.describe("accessibility (?llm=fake, panel populated)", () => {
  let context: BrowserContext;
  let page: Page;
  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    // Not browser.newPage(): that shorthand marks the context single-page ("Please use
    // browser.newContext()"), and AxeBuilder.analyze() needs to open a second, blank page in the
    // same context to aggregate results (finishRun in @axe-core/playwright).
    context = await browser.newContext();
    page = await context.newPage();
    await openPopulated(page);
  });
  test.afterAll(async () => {
    await context?.close();
  });

  test("0 serious/critical axe violations in light mode", async () => {
    const found = await seriousOrCritical(page);
    expect(found, JSON.stringify(found, null, 2)).toEqual([]);
  });

  test("0 serious/critical axe violations in dark mode", async () => {
    await page.click(".theme-toggle");
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark", null, { timeout: 5_000 });
    const found = await seriousOrCritical(page);
    expect(found, JSON.stringify(found, null, 2)).toEqual([]);
  });
});
