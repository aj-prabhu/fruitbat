import { expect, test } from "./model-cache";
import type { Page } from "@playwright/test";
import { gotoIsolated } from "./isolated";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// S1-02 proof (docs/PLAN.md): selection -> "Read" chip within 100 ms, clicking it or pressing
// ⌥R runs the selection at the dial's current level, a selection under 20 chars shows no chip,
// Esc hides it, and the paste box shows a word count and runs on "Read this". Runs on `wasm-ci`
// (headless bundled Chromium; no LLM/TTS involved, this packet only calls window.__fruitbat.run).
const specDir = fileURLToPath(new URL("../../spec/", import.meta.url));
const dialSpec = JSON.parse(readFileSync(specDir + "dial.json", "utf8")) as { default: string };

/**
 * Selects the first `count` characters of the sample article's first paragraph text node and
 * dispatches a real `mouseup` on `document`, exactly like a mouse drag-to-select would leave
 * behind (Build spec: "a page.evaluate that sets a Range plus a synthetic mouseup"). Returns the
 * selection's trimmed text and, for the timing test, how long the chip took to appear.
 */
async function selectArticleChars(page: Page, count: number): Promise<{ text: string }> {
  return page.evaluate((n) => {
    const p = document.querySelector<HTMLParagraphElement>(".article p");
    if (!p || !p.firstChild) throw new Error("sample article not rendered");
    const textNode = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(n, textNode.length));
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return { text: sel.toString().trim() };
  }, count);
}

/** Selects >= 20 chars and waits (in-page) for the chip to actually appear, for tests that only
 * care about the end state, not the timing itself (that's the dedicated timing test below). */
async function selectAndShowChip(page: Page): Promise<{ text: string }> {
  const result = await selectArticleChars(page, 200);
  await expect(page.locator(".read-chip")).toBeVisible();
  return result;
}

test.describe("intake: selection chip", () => {
  test("a >= 20 char selection shows the chip within 100 ms of mouseup", async ({ page }) => {
    await gotoIsolated(page, "/");
    await expect(page.locator(".article p").first()).toBeVisible();

    const elapsedMs = await page.evaluate(() => {
      const p = document.querySelector<HTMLParagraphElement>(".article p")!;
      const textNode = p.firstChild as Text;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(200, textNode.length)); // well over the 20-char floor
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);

      const mouseupAt = performance.now();
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      return new Promise<number>((resolve) => {
        const deadline = mouseupAt + 1000; // generous cap; failure shows up as > 100 below either way
        function poll() {
          if (document.querySelector(".read-chip")) {
            resolve(performance.now() - mouseupAt);
            return;
          }
          if (performance.now() > deadline) {
            resolve(Number.POSITIVE_INFINITY);
            return;
          }
          requestAnimationFrame(poll);
        }
        requestAnimationFrame(poll);
      });
    });

    expect(elapsedMs).toBeLessThanOrEqual(100);
  });

  test("clicking the chip runs the selection at the current level and increments stats", async ({ page }) => {
    await gotoIsolated(page, "/");
    await expect(page.locator(".article p").first()).toBeVisible();
    const { text } = await selectAndShowChip(page);

    const before = await page.evaluate(() => window.__fruitbat.stats());
    await page.click(".read-chip");
    const after = await page.evaluate(() => window.__fruitbat.stats());

    expect(after.runs).toBe(before.runs + 1);
    expect(after.last).toEqual({ level: dialSpec.default, chars: text.length });
    await expect(page.locator(".read-chip")).toHaveCount(0);
  });

  test("⌥R runs the current selection", async ({ page }) => {
    await gotoIsolated(page, "/");
    await expect(page.locator(".article p").first()).toBeVisible();
    const { text } = await selectArticleChars(page, 200);

    const before = await page.evaluate(() => window.__fruitbat.stats());
    await page.keyboard.press("Alt+R");
    const after = await page.evaluate(() => window.__fruitbat.stats());

    expect(after.runs).toBe(before.runs + 1);
    expect(after.last).toEqual({ level: dialSpec.default, chars: text.length });
  });

  test("⌥R with no selection does nothing", async ({ page }) => {
    await gotoIsolated(page, "/");
    await expect(page.locator(".article p").first()).toBeVisible();
    await page.evaluate(() => window.getSelection()!.removeAllRanges());

    const before = await page.evaluate(() => window.__fruitbat.stats());
    await page.keyboard.press("Alt+R");
    const after = await page.evaluate(() => window.__fruitbat.stats());

    expect(after.runs).toBe(before.runs);
  });

  test("a selection under 20 chars shows no chip", async ({ page }) => {
    await gotoIsolated(page, "/");
    await expect(page.locator(".article p").first()).toBeVisible();
    await selectArticleChars(page, 10);

    await page.waitForTimeout(150); // give a (wrongly) delayed chip every chance to appear
    await expect(page.locator(".read-chip")).toHaveCount(0);
  });

  test("Esc hides the chip", async ({ page }) => {
    await gotoIsolated(page, "/");
    await expect(page.locator(".article p").first()).toBeVisible();
    await selectAndShowChip(page);

    await page.keyboard.press("Escape");
    await expect(page.locator(".read-chip")).toHaveCount(0);
  });
});

test.describe("intake: paste box", () => {
  test("shows a live word count and 'Read this' runs the pasted text", async ({ page }) => {
    await gotoIsolated(page, "/");
    const textarea = page.locator(".paste-textarea");
    const readButton = page.locator(".read-button");

    await expect(readButton).toBeDisabled();

    const pasted = "one two three four five";
    await textarea.fill(pasted);
    await expect(page.locator(".word-count")).toHaveAttribute("data-word-count", "5");
    await expect(readButton).toBeEnabled();

    const before = await page.evaluate(() => window.__fruitbat.stats());
    await readButton.click();
    const after = await page.evaluate(() => window.__fruitbat.stats());

    expect(after.runs).toBe(before.runs + 1);
    expect(after.last).toEqual({ level: dialSpec.default, chars: pasted.length });
  });

  test("Cmd/Ctrl+Enter also runs the pasted text", async ({ page }) => {
    await gotoIsolated(page, "/");
    const textarea = page.locator(".paste-textarea");
    const pasted = "read this with a keyboard shortcut please";
    await textarea.fill(pasted);

    const before = await page.evaluate(() => window.__fruitbat.stats());
    await textarea.press("Control+Enter");
    const after = await page.evaluate(() => window.__fruitbat.stats());

    expect(after.runs).toBe(before.runs + 1);
    expect(after.last).toEqual({ level: dialSpec.default, chars: pasted.length });
  });
});
