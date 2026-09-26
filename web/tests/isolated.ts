import type { Page } from "@playwright/test";

// Every page loads coi-serviceworker.js. On a fresh browser context it registers its worker and
// reloads the page once; a test that acts before that reload gets "Execution context was
// destroyed". If the reload lands before the worker controls the page, the library's
// reload-once guard leaves the page unisolated for good. Both were flaking wasm-ci on main
// since #2. This waits through the reload and, if isolation still has not arrived, reloads
// again so the now-active worker serves the page (a real user's next visit gets the same).
export async function gotoIsolated(page: Page, url: string): Promise<void> {
  await page.goto(url);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.waitForFunction(() => (window as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated === true, null, { timeout: 15_000 });
      await page.waitForLoadState("load");
      return;
    } catch {
      await page.reload();
    }
  }
  throw new Error("crossOriginIsolated never became true");
}
