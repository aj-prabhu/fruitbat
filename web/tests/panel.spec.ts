import { test, expect, type Page, type Browser } from "@playwright/test";
import { gotoIsolated } from "./isolated";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// S1-07 proof (docs/PLAN.md): the real panel (web/src/ui/Panel.tsx) on the real app at `/`, with
// the scripted summarizer (`?llm=fake`, C5) and the real voice (Kokoro q8 on WASM, same as
// dial.spec.ts). Bullets appear and the spoken one gets aria-current; the Read-all view shows the
// current sentence large and the next dimmed; the rate slider persists across reload; Stop/Pause/
// Resume/Skip drive `play`; an all-cut chunk offers "Read this part"; light/dark screenshots of
// the panel are written and non-empty.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC011 = readFileSync(path.join(ROOT, "spec/eval/corpus/011.txt"), "utf8");
const P011 = DOC011.split(/\n{2,}/)
  .map((p) => p.trim())
  .filter(Boolean);
const STRINGS = (JSON.parse(readFileSync(path.join(ROOT, "spec/strings/en.json"), "utf8")) as { strings: Record<string, string> }).strings;
const SCREENSHOT_DIR = path.join(ROOT, "web/test-results");

type Cursor =
  | { kind: "bullet"; chunkIndex: number; index: number }
  | { kind: "sentence"; start: number; end: number; text: string; next: string | null };
type Snap = {
  gen: string;
  play: string;
  bullets: { text: string; chunkIndex: number }[];
  current: Cursor | null;
  allCut: number[];
  prewarmed: boolean;
};
type Api = {
  run(t: string, l: string): void;
  stop(): void;
  state(): Snap;
  setLevel(l: string): Promise<void>;
};
type W = { __fruitbat: Api };

const snap = (page: Page) => page.evaluate(() => (window as unknown as W).__fruitbat.state());

async function open(page: Page, query: string) {
  await gotoIsolated(page, `/${query}`);
  await page.waitForFunction(() => typeof (window as unknown as Partial<W>).__fruitbat?.state === "function", null, { timeout: 20_000 });
  // Same as dial.spec.ts: the voice loads on page load and prewarms; wait for it so control
  // interactions (rate/voice/speak) act on a ready engine, matching the product.
  await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().prewarmed, null, { timeout: 300_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("panel (?llm=fake&delay=40)", () => {
  let page: Page;
  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    page = await browser.newPage();
    await open(page, "?llm=fake&delay=40");
  });
  test.afterAll(async () => {
    await page?.close();
  });

  test("bullets appear and the one being spoken gets aria-current", async () => {
    await page.evaluate((t) => (window as unknown as W).__fruitbat.run(t, "short"), DOC011);
    await page.waitForFunction(
      () => {
        const s = (window as unknown as W).__fruitbat.state();
        return s.bullets.length >= 1 && s.current?.kind === "bullet";
      },
      null,
      { timeout: 60_000 },
    );
    const s = await snap(page);
    const curIndex = s.current?.kind === "bullet" ? s.current.index : -1;
    const items = page.locator(".panel-bullets li");
    await expect(items).toHaveCount(s.bullets.length);
    const current = page.locator('.panel-bullets li[aria-current="true"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText(s.bullets[curIndex].text);
    await page.evaluate(() => (window as unknown as W).__fruitbat.stop());
  });

  test("Read-all view shows the current sentence large and the next dimmed", async () => {
    await page.evaluate((t) => (window as unknown as W).__fruitbat.run(t, "readall"), P011[0]);
    await page.waitForFunction(
      () => {
        const s = (window as unknown as W).__fruitbat.state();
        return s.current?.kind === "sentence" && s.current.next !== null;
      },
      null,
      { timeout: 60_000 },
    );
    const s = await snap(page);
    const cur = s.current as Extract<Cursor, { kind: "sentence" }>;
    const now = page.locator(".now-text");
    const next = page.locator(".next-text");
    await expect(now).toHaveText(cur.text);
    await expect(next).toHaveText(cur.next as string);
    const [nowSize, nextSize, nowColor, nextColor] = await Promise.all([
      now.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      next.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      now.evaluate((el) => getComputedStyle(el).color),
      next.evaluate((el) => getComputedStyle(el).color),
    ]);
    expect(nowSize, "current sentence reads larger than the next one").toBeGreaterThan(nextSize);
    expect(nextColor, "the next sentence is visually dimmed (a distinct, muted color)").not.toBe(nowColor);
    await page.evaluate(() => (window as unknown as W).__fruitbat.stop());
  });

  test("rate slider change persists across reload", async () => {
    const slider = page.locator('[data-testid="rate-slider"]');
    await expect(slider).toBeVisible();
    // Native range inputs need the value set + a real "input" event dispatched (Playwright's
    // fill() targets text-like inputs); this is exactly what dragging the thumb does.
    await slider.evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, "1.3");
    await expect(page.locator('[data-testid="rate-value"]')).toHaveText("1.30×");
    const stored = await page.evaluate(() => localStorage.getItem("fruitbat.rate"));
    expect(stored).toBe("1.3");

    await page.reload();
    await page.waitForFunction(() => typeof (window as unknown as Partial<W>).__fruitbat?.state === "function", null, { timeout: 20_000 });
    const afterReload = await page.evaluate(() => localStorage.getItem("fruitbat.rate"));
    expect(afterReload).toBe("1.3");
    await expect(page.locator('[data-testid="rate-slider"]')).toHaveValue("1.3");
  });

  test("Stop/Pause/Resume/Skip buttons drive play", async () => {
    await page.evaluate((t) => (window as unknown as W).__fruitbat.run(t, "short"), DOC011);
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().play === "playing", null, { timeout: 60_000 });

    const pause = page.getByRole("button", { name: STRINGS["panel.pause"], exact: true });
    await pause.click();
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().play === "paused", null, { timeout: 10_000 });

    const resume = page.getByRole("button", { name: STRINGS["panel.resume"], exact: true });
    await expect(resume).toBeVisible();
    await resume.click();
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().play === "playing", null, { timeout: 10_000 });

    const skip = page.getByRole("button", { name: STRINGS["panel.skip"], exact: true });
    await skip.click(); // no crash / stuck state is the bar here; the queue's own skip is S1-04's

    const stop = page.getByRole("button", { name: STRINGS["panel.stop"], exact: true });
    await stop.click();
    await page.waitForFunction(() => {
      const s = (window as unknown as W).__fruitbat.state();
      return s.gen === "idle" && s.play === "stopped";
    }, null, { timeout: 10_000 });
  });
});

test.describe("all-cut chunk shows Read this part (?llm=fake&fake=cutshort)", () => {
  test("button appears and is labeled from spec/strings/en.json", async ({ page }) => {
    await open(page, "?llm=fake&fake=cutshort");
    await page.evaluate((t) => (window as unknown as W).__fruitbat.run(t, "short"), P011[0]);
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().gen === "done", null, { timeout: 60_000 });
    const button = page.locator("button.read-part[data-chunk='0']");
    await expect(button).toBeVisible();
    await expect(button).toContainText(STRINGS["panel.read_this_part"]);
    await button.click();
    await page.waitForFunction(() => (window as unknown as W).__fruitbat.state().play === "playing", null, { timeout: 60_000 });
    await page.evaluate(() => (window as unknown as W).__fruitbat.stop());
  });
});

test.describe("panel screenshots", () => {
  test("light and dark screenshots are written and non-empty", async ({ page }) => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await open(page, "?llm=fake&delay=40");
    await page.evaluate((t) => (window as unknown as W).__fruitbat.run(t, "short"), DOC011);
    await page.waitForFunction(
      () => {
        const s = (window as unknown as W).__fruitbat.state();
        return s.bullets.length >= 1;
      },
      null,
      { timeout: 60_000 },
    );
    const panel = page.locator("#panel");

    const lightPath = path.join(SCREENSHOT_DIR, "panel-light.png");
    await panel.screenshot({ path: lightPath });

    await page.click(".theme-toggle");
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark", null, { timeout: 5_000 });
    const darkPath = path.join(SCREENSHOT_DIR, "panel-dark.png");
    await panel.screenshot({ path: darkPath });

    await page.evaluate(() => (window as unknown as W).__fruitbat.stop());

    for (const p of [lightPath, darkPath]) {
      expect(existsSync(p), `${p} exists`).toBe(true);
      expect(statSync(p).size, `${p} is non-empty`).toBeGreaterThan(0);
    }
  });
});
