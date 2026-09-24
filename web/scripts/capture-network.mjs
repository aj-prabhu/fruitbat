// S1-00b: record every request URL and redirect host from a cold load + one summary on a
// deployed URL. Output feeds spec/network.json (web.redirect_hosts) and docs/qa/.
//   BASE_URL=https://2shay-fruitbat-dev.static.hf.space node scripts/capture-network.mjs out.json
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const base = process.env.BASE_URL;
const out = process.argv[2] ?? "network-capture.json";
if (!base) throw new Error("BASE_URL required");
const TEXT = "Bats are the only mammals that can truly fly. More than 1,400 species live on every continent except Antarctica. A single little brown bat can eat up to 1,000 insects in one hour. Most bats find their way in the dark by echolocation. Since 2006 white-nose syndrome has killed millions of bats in North America.";

const browser = await chromium.launch({ headless: false, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const context = await browser.newContext(); // fresh profile = cold cache
const page = await context.newPage();
const requests = [];
page.on("response", async (res) => {
  const req = res.request();
  requests.push({ method: req.method(), url: req.url(), status: res.status(), from: req.redirectedFrom()?.url() ?? null, type: req.resourceType() });
});
await page.goto(base + "/");
for (let i = 0; i < 3; i++) {
  try { await page.waitForFunction(() => crossOriginIsolated === true, null, { timeout: 15000 }); break; } catch { await page.waitForLoadState("load"); }
}
await page.waitForFunction(() => window.__skeleton?.state === "idle", null, { timeout: 20000 });
await page.fill("#text", TEXT);
await page.click("#go");
await page.waitForFunction(() => ["done", "failed"].includes(window.__skeleton.state), null, { timeout: 9 * 60_000 });
const s = await page.evaluate(() => { const S = window.__skeleton; return { state: S.state, error: S.error, bullets: S.bullets, isolated: S.isolated, timings: S.timings }; });
await browser.close();

const hosts = {};
for (const r of requests) { const h = new URL(r.url).host; hosts[h] = (hosts[h] ?? 0) + 1; }
const redirects = requests.filter((r) => r.from).map((r) => ({ from: new URL(r.from).host, to: new URL(r.url).host }));
const redirectHosts = [...new Set(redirects.map((r) => r.to))];
await writeFile(out, JSON.stringify({ base, capturedAt: new Date().toISOString(), result: s, hosts, redirectHosts, requests }, null, 2));
console.log(JSON.stringify({ state: s.state, bullets: s.bullets.length, isolated: s.isolated, hosts, redirectHosts, requestCount: requests.length }, null, 2));
