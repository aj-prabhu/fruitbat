import { test, expect, type Page, type Request as PwRequest } from "@playwright/test";
import { gotoIsolated } from "./isolated";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// S1-12 proof (docs/PLAN.md, packet v3+v4): the privacy non-negotiable (rule 1) enforced by a
// test, not just trusted from reading net.ts. Both projects record every request (method, full
// URL, headers, body where practical) across a cold load and a full run at every dial level, on
// a source that carries the canary `CANARY-7f3a` in four forms (literal, a manually-forced
// percent-encoding of the dash, base64, hex), and assert:
//   - every request is GET;
//   - every request's URL is a same-origin path in the Vite manifest or public/, an exact pinned
//     Hub file URL (spec/network.json), or (only for a request the browser itself redirected, or
//     the final URL the coi-serviceworker reports via `X-Fruitbat-Final-Url` -- it hides real
//     redirect hops from page-level Playwright capture once it controls the page, so that header
//     is the only way to see them) a redirect target on a listed host carrying one of our pinned
//     files' file name;
//   - no query string anywhere except the recorded redirect parameter names (the top-level
//     navigation's OWN query string is exempt from that rule: it only ever carries this test's
//     own harness flags -- `?llm=fake` and friends -- which select code paths, not data, and never
//     leave this same-origin page; every canary-scan below still runs over it);
//   - no URL, header, or body contains any canary form;
//   - the Hub file URLs actually requested are exactly the expected set for the run (Kokoro only
//     when the LLM is faked; the default summarizer tier + Kokoro on a real run).
// `WebSocket`, `RTCPeerConnection`, `navigator.sendBeacon`, `EventSource` are stubbed to throw
// (main page context only -- dedicated Workers get a fresh global scope addInitScript can't
// reach; scripts/check-network.sh is the source-level backstop for those) and the run must not
// throw. The CSP meta (scripts/csp.mjs) must be present and must actually block an off-list
// fetch in the browser (a `securitypolicyviolation` event, not just a rejected promise).
//
// wasm-ci: Read all (real Kokoro) + short/caveman/oneline via the scripted worker (`?llm=fake`),
// plus a *real* (non-fake) summarize attempt with no WebGPU, which must degrade cleanly (no bytes
// fetched, no throw, no leak). webgpu-local: the same sweep for real, on every level, with no
// `?llm=fake` at all; also saves the request log to docs/qa/privacy-requests-<commit>.json.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB_ROOT = path.resolve(ROOT, "web");

type Level = "readall" | "short" | "caveman" | "oneline";

// ---------------------------------------------------------------------------------------------
// The canary. All four forms must never appear in any request URL, header, or scannable body.
// ---------------------------------------------------------------------------------------------
const CANARY_LITERAL = "CANARY-7f3a";
const CANARY_URLENC = "CANARY%2D7f3a"; // a forced percent-encoding of the dash, not what
// encodeURIComponent produces by default (it leaves "-" alone) -- this catches code that does its
// own manual percent-encoding, not just the browser's.
const CANARY_BASE64 = "Q0FOQVJZLTdmM2E=";
const CANARY_HEX = "43414e4152592d37663361";
const CANARY_FORMS = [CANARY_LITERAL, CANARY_URLENC, CANARY_BASE64, CANARY_HEX, CANARY_HEX.toUpperCase()];

const CANARY_TEXT = [
  `The bat colony's tracking tag reads ${CANARY_LITERAL} on its transmitter label.`,
  `An older paper logbook instead writes the same tag as ${CANARY_URLENC}.`,
  `The lab's backup spreadsheet stores it as the base64 string ${CANARY_BASE64}.`,
  `A separate audit sheet renders the identical tag in hex as ${CANARY_HEX}.`,
  `None of these four forms of the tag should ever reach a server outside this machine.`,
].join(" ");

const TEST_HARNESS_PARAMS = new Set(["llm", "inject", "delay", "fake", "model", "prompt", "chunk", "tts"]);

// ---------------------------------------------------------------------------------------------
// spec/ as the allowlist (no import of web/src/engine/net.ts: Playwright's test loader can't
// handle its bare JSON import -- see the comment in tests/smoke.spec.ts).
// ---------------------------------------------------------------------------------------------
interface PinnedFile {
  path: string;
}
interface PinnedModel {
  id: string;
  revision: string;
  url_template: string;
  files: PinnedFile[];
}
interface ModelsJson {
  web: { summarizer: PinnedModel; voice: PinnedModel };
}
interface NetworkJson {
  web: {
    hub_files: { allowed_urls: string[]; observed_2026_09_24?: string[] };
    redirect_hosts: string[];
    redirect_host_patterns: string[];
    redirect_query_params: Record<string, string[]>;
  };
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, rel), "utf8")) as T;
}

function pinnedFileUrl(model: PinnedModel, filePath: string): string {
  return model.url_template.replace("{id}", model.id).replace("{revision}", model.revision).replace("{path}", filePath);
}

function fileUrls(model: PinnedModel): string[] {
  return model.files.map((f) => pinnedFileUrl(model, f.path));
}

interface Allowlist {
  sameOrigin: Set<string>;
  hubExact: Set<string>;
  redirectHosts: string[];
  redirectPatterns: string[];
  redirectParams: Record<string, string[]>;
}

function listPublic(dir: string, prefix: string, out: Set<string>): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) listPublic(full, `${prefix}${name}/`, out);
    else out.add(`/${prefix}${name}`);
  }
}

function buildAllowlist(network: NetworkJson): Allowlist {
  const manifestPath = path.join(WEB_ROOT, "dist/.vite/manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`privacy.spec.ts: ${manifestPath} missing -- run \`npm run build\` first (the webServer config should have done this)`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
    string,
    { file?: string; css?: string[]; assets?: string[] }
  >;
  const sameOrigin = new Set<string>(["/", "/favicon.ico"]);
  for (const [key, entry] of Object.entries(manifest)) {
    if (key.endsWith(".html")) sameOrigin.add(`/${key}`);
    if (entry.file) sameOrigin.add(`/${entry.file}`);
    for (const c of entry.css ?? []) sameOrigin.add(`/${c}`);
    for (const a of entry.assets ?? []) sameOrigin.add(`/${a}`);
  }
  listPublic(path.join(WEB_ROOT, "public"), "", sameOrigin);
  return {
    sameOrigin,
    hubExact: new Set(network.web.hub_files.allowed_urls),
    redirectHosts: network.web.redirect_hosts,
    redirectPatterns: network.web.redirect_host_patterns,
    redirectParams: network.web.redirect_query_params,
  };
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** Is `u` a legitimate redirect target for one of our pinned files? (mirrors net.ts's
 *  redirectAllowed(), reimplemented standalone -- see the header comment on why.) */
function validateRedirectTarget(u: URL, allow: Allowlist): { ok: boolean; reason?: string } {
  const hostOk =
    allow.redirectHosts.includes(u.host) ||
    allow.redirectPatterns.some((p) => p.startsWith("*.") && u.host.endsWith(p.slice(1)) && u.host.length > p.length - 1);
  if (!hostOk) return { ok: false, reason: `host not a recorded redirect host: ${u.host}` };

  let matched: string | null = null;
  const cacheMatch = /^\/api\/resolve-cache\/models\/(.+)\/([0-9a-f]{40})\/(.+)$/.exec(u.pathname);
  if (cacheMatch) {
    const candidate = `https://huggingface.co/${cacheMatch[1]}/resolve/${cacheMatch[2]}/${cacheMatch[3]}`;
    if (allow.hubExact.has(candidate)) matched = candidate;
  }
  if (!matched) {
    const disp = u.searchParams.get("response-content-disposition");
    if (disp) {
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
      if (m) {
        const fname = decodeURIComponent(m[1]);
        matched = [...allow.hubExact].find((h) => basename(h) === fname) ?? null;
      }
    }
  }
  if (!matched) return { ok: false, reason: "redirect target does not resolve to any pinned file" };

  const matchedPath = new URL(matched).pathname; // the huggingface.co small-file redirect (Form A)
  // carries this PATHNAME, not the full URL, as a query param NAME (S1-00b observed it; net.ts's
  // redirectAllowed() compares against pathnames for the same reason).
  // A host under a recorded pattern (another CDN region, e.g. eu.aws.cdn.hf.co) inherits the
  // parameter names recorded for every host under the same pattern, as net.ts does
  // (Codex review, PR #21).
  const patternOf = (host: string) => allow.redirectPatterns.find((pat) => pat.startsWith("*.") && host.endsWith(pat.slice(1)) && host.length > pat.length - 1) ?? null;
  const allowedParams = new Set<string>(allow.redirectParams[u.host] ?? []);
  if (allowedParams.size === 0) {
    const pat = patternOf(u.host);
    if (pat) for (const [h, names] of Object.entries(allow.redirectParams)) if (patternOf(h) === pat) names.forEach((n) => allowedParams.add(n));
  }
  for (const key of u.searchParams.keys()) {
    if (allowedParams.has(key)) continue;
    if (decodeURIComponent(key) === matchedPath) continue; // the pinned path travels as a param NAME
    return { ok: false, reason: `redirect query parameter not recorded for ${u.host}: ${key}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------
interface Rec {
  url: string;
  method: string;
  resourceType: string;
  redirectedFrom: string | null;
  status: number | null;
  finalUrlHeader: string | null;
  /** made by the coi-serviceworker on the page's behalf (visible at context scope only) */
  fromServiceWorker: boolean;
}

function scan(where: string, value: string, hits: string[]): void {
  for (const form of CANARY_FORMS) {
    if (value.includes(form)) hits.push(`${where} contains canary form ${JSON.stringify(form)}`);
  }
}

async function attachRecorder(page: Page) {
  const records: Rec[] = [];
  const byUrl = new Map<string, Rec>();
  const canaryHits: string[] = [];
  const pageErrors: string[] = [];

  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // Context scope, not page scope: after gotoIsolated the COI service worker fetches on the page's
  // behalf, and those requests are reported on the context only (Codex review, PR #21).
  const ctx = page.context();
  ctx.on("request", (req: PwRequest) => {
    const rec: Rec = {
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      redirectedFrom: req.redirectedFrom()?.url() ?? null,
      status: null,
      finalUrlHeader: null,
      fromServiceWorker: req.serviceWorker() !== null,
    };
    records.push(rec);
    byUrl.set(rec.url, rec);
    scan(`request url`, rec.url, canaryHits);
    const headers = req.headers();
    for (const [k, v] of Object.entries(headers)) scan(`request header ${k} on ${rec.url}`, v, canaryHits);
    const body = req.postData();
    if (body) scan(`request body on ${rec.url}`, body, canaryHits);
  });

  ctx.on("response", async (res) => {
    const req = res.request();
    const rec = byUrl.get(req.url());
    const headers = res.headers();
    if (rec) {
      rec.status = res.status();
      rec.finalUrlHeader = headers["x-fruitbat-final-url"] ?? null;
    }
    for (const [k, v] of Object.entries(headers)) scan(`response header ${k} on ${req.url()}`, v, canaryHits);
    const ct = headers["content-type"] ?? "";
    const scannable = /^(text\/|application\/json|application\/javascript|application\/x-javascript)/.test(ct);
    if (scannable) {
      const len = Number(headers["content-length"] ?? "0");
      if (!len || len < 5_000_000) {
        try {
          scan(`response body on ${req.url()}`, await res.text(), canaryHits);
        } catch {
          // navigated away / aborted before the body was readable: not a leak signal
        }
      }
    }
  });

  // context.route to see request bodies as raw bytes too (a non-UTF8 body would mangle
  // postData()'s string form): continues every request unmodified, just observes.
  await page.context().route("**/*", async (route) => {
    const buf = route.request().postDataBuffer();
    if (buf && buf.length) scan(`request body (route) on ${route.request().url()}`, buf.toString("utf8"), canaryHits);
    await route.continue();
  });

  return { records, canaryHits, pageErrors };
}

function evaluateAllowlist(records: Rec[], allow: Allowlist, baseOrigin: string): { violations: string[]; hubSeen: Set<string> } {
  const violations: string[] = [];
  const hubSeen = new Set<string>();

  for (const rec of records) {
    if (rec.method !== "GET") violations.push(`non-GET request: ${rec.method} ${rec.url}`);

    let u: URL;
    try {
      u = new URL(rec.url);
    } catch {
      violations.push(`unparseable request URL: ${rec.url}`);
      continue;
    }

    if (rec.redirectedFrom) {
      // The browser itself followed a redirect to get here (only ever visible before the
      // coi-serviceworker takes control of the page): validate this hop as a redirect target.
      const v = validateRedirectTarget(u, allow);
      if (!v.ok) violations.push(`redirect hop ${rec.url}: ${v.reason}`);
    } else if (u.origin === baseOrigin) {
      if (rec.resourceType === "document" || (rec.fromServiceWorker && u.pathname.match(/^\/([\w-]+\.html)?$/))) {
        // A navigation, or the coi-serviceworker re-fetching that same page to add its isolation
        // headers: only the test harness's own flags may ride on it.
        const badParams = [...u.searchParams.keys()].filter((k) => !TEST_HARNESS_PARAMS.has(k));
        if (badParams.length) violations.push(`unexpected query param(s) on navigation ${rec.url}: ${badParams.join(",")}`);
      } else if (u.search !== "") {
        violations.push(`query string on same-origin request: ${rec.url}`);
      }
      if (!allow.sameOrigin.has(u.pathname)) {
        violations.push(`same-origin path not in manifest/public: ${u.pathname}`);
      }
    } else {
      const originPath = u.origin + u.pathname;
      if (allow.hubExact.has(originPath)) {
        if (u.search !== "") violations.push(`query string on exact pinned Hub file: ${rec.url}`);
        hubSeen.add(originPath);
      } else {
        violations.push(`URL not on any allowlist: ${rec.url}`);
      }
    }

    if (rec.finalUrlHeader && rec.finalUrlHeader !== rec.url) {
      let f: URL;
      try {
        f = new URL(rec.finalUrlHeader);
      } catch {
        violations.push(`unparseable X-Fruitbat-Final-Url: ${rec.finalUrlHeader}`);
        continue;
      }
      if (f.origin !== baseOrigin) {
        const v = validateRedirectTarget(f, allow);
        if (!v.ok) violations.push(`X-Fruitbat-Final-Url ${rec.finalUrlHeader} (from ${rec.url}): ${v.reason}`);
      }
    }
  }
  return { violations, hubSeen };
}

// ---------------------------------------------------------------------------------------------
// Driving the app through window.__fruitbat (main.tsx / S1-06 orchestrator)
// ---------------------------------------------------------------------------------------------
interface Snapshot {
  gen: "idle" | "loading" | "running" | "done" | "failed";
  bullets: { text: string; chunkIndex: number }[];
  notices: string[];
  error: string | null;
  prewarmed: boolean;
}
type FruitbatWindow = { __fruitbat: { run(t: string, l: Level): void; state(): Snapshot } };

async function waitReady(page: Page, prewarmTimeoutMs = 300_000): Promise<void> {
  await page.waitForFunction(() => typeof (window as unknown as Partial<FruitbatWindow>).__fruitbat?.state === "function", null, {
    timeout: 20_000,
  });
  // Rule 11: the voice loads on page load. Waiting for it prewarmed means the Kokoro download
  // (Read all's model) has already fully happened by the time the canary runs start.
  await page.waitForFunction(() => (window as unknown as FruitbatWindow).__fruitbat.state().prewarmed === true, null, {
    timeout: prewarmTimeoutMs,
  });
}

async function runLevel(page: Page, level: Level, timeoutMs: number): Promise<Snapshot> {
  await page.evaluate(([t, l]) => (window as unknown as FruitbatWindow).__fruitbat.run(t, l), [CANARY_TEXT, level] as const);
  await page.waitForFunction(
    () => {
      const g = (window as unknown as FruitbatWindow).__fruitbat.state().gen;
      return g === "done" || g === "failed";
    },
    null,
    { timeout: timeoutMs },
  );
  // gen turns "done" before the summary's speech has been synthesized and played; wait for the
  // voice to drain so every request the run makes is in the log (Codex review, PR #21).
  await page.waitForFunction(
    () => {
      const s = (window as unknown as FruitbatWindow).__fruitbat.state() as unknown as { play: string; voice: { inFlight: number; enqueued: number; ended: number } };
      return s.play !== "playing" && s.play !== "paused" && s.voice.inFlight === 0 && s.voice.enqueued <= s.voice.ended;
    },
    null,
    { timeout: timeoutMs },
  );
  return page.evaluate(() => (window as unknown as FruitbatWindow).__fruitbat.state());
}

async function installStubs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const boom = (name: string): never => {
      throw new Error(`fruitbat privacy test: ${name} must never be used`);
    };
    // @ts-expect-error -- intentionally replacing the global with a throwing stand-in
    window.WebSocket = function WebSocket() {
      boom("WebSocket");
    };
    // @ts-expect-error -- see above
    window.RTCPeerConnection = function RTCPeerConnection() {
      boom("RTCPeerConnection");
    };
    // @ts-expect-error -- see above
    window.EventSource = function EventSource() {
      boom("EventSource");
    };
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: () => boom("navigator.sendBeacon"),
    });
  });
}

async function assertCspBlocksOffList(page: Page): Promise<void> {
  const cspContent = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(cspContent, "CSP meta must be present").toBeTruthy();
  expect(cspContent).toContain("connect-src");
  const result = await page.evaluate(async () => {
    const state: { violation: { directive: string; blockedURI: string } | null } = { violation: null };
    const onViolation = (e: SecurityPolicyViolationEvent) => {
      state.violation = { directive: e.violatedDirective, blockedURI: e.blockedURI };
    };
    document.addEventListener("securitypolicyviolation", onViolation, { once: true });
    let outcome: string;
    try {
      await fetch("https://example.com/x");
      outcome = "resolved";
    } catch (e) {
      outcome = `rejected:${e instanceof Error ? e.message : String(e)}`;
    }
    await new Promise((r) => setTimeout(r, 150));
    document.removeEventListener("securitypolicyviolation", onViolation);
    return { outcome, violation: state.violation };
  });
  expect(result.outcome.startsWith("rejected"), `off-list fetch must be blocked by the browser's CSP, got: ${result.outcome}`).toBe(true);
  expect(result.violation, "a securitypolicyviolation event must fire for connect-src").not.toBeNull();
  expect(result.violation?.directive).toContain("connect-src");
}

function assertSetEqual(actual: Set<string>, expected: Set<string>, label: string): void {
  const missing = [...expected].filter((u) => !actual.has(u)).sort();
  const extra = [...actual].filter((u) => !expected.has(u)).sort();
  expect(missing, `${label}: expected Hub requests never seen`).toEqual([]);
  expect(extra, `${label}: unexpected extra Hub requests`).toEqual([]);
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------
test.describe.configure({ mode: "serial" });

test.describe("privacy: full sweep on the real app", () => {
  test("wasm-ci: cold load + every level (?llm=fake, real Kokoro for Read all) -- no leaks, exact Hub set, CSP enforced", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "wasm-ci", "wasm-ci only");
    const network = readJson<NetworkJson>("spec/network.json");
    const models = readJson<ModelsJson>("spec/models.json");
    const allow = buildAllowlist(network);
    await installStubs(page);
    const { records, canaryHits, pageErrors } = await attachRecorder(page);

    await gotoIsolated(page, "/?llm=fake");
    await waitReady(page);

    for (const level of ["readall", "short", "caveman", "oneline"] as const) {
      const snap = await runLevel(page, level, 180_000);
      expect(snap.gen, `level ${level} failed: ${snap.error ?? ""}`).toBe("done");
    }

    await assertCspBlocksOffList(page);

    expect(canaryHits, "canary must never appear in any request URL, header, or scanned body").toEqual([]);
    expect(pageErrors, "WebSocket/RTCPeerConnection/sendBeacon/EventSource stubs must never fire").toEqual([]);

    const baseOrigin = new URL(page.url()).origin;
    const { violations, hubSeen } = evaluateAllowlist(records, allow, baseOrigin);
    expect(violations, "every request must be same-origin (manifest/public), an exact pinned Hub file, or a valid redirect target").toEqual([]);

    // ?llm=fake never touches the real summarizer: only Kokoro (Read all's voice) should have
    // been requested from the Hub.
    assertSetEqual(hubSeen, new Set(fileUrls(models.web.voice)), "wasm-ci fake-llm sweep");

    console.log(`PRIVACY_WASM_CI requests=${records.length} hub_files=${hubSeen.size} canary_hits=0`);
  });

  test("wasm-ci: a real (non-fake) summarize attempt degrades cleanly with no WebGPU -- no bytes fetched, no leak", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "wasm-ci", "wasm-ci only");
    const network = readJson<NetworkJson>("spec/network.json");
    const models = readJson<ModelsJson>("spec/models.json");
    const allow = buildAllowlist(network);
    await installStubs(page);
    const { records, canaryHits, pageErrors } = await attachRecorder(page);

    await gotoIsolated(page, "/"); // no ?llm=fake: the real summarizer path, with WebGPU disabled by the project
    await waitReady(page);

    const snap = await runLevel(page, "short", 30_000);
    expect(snap.gen, "a real summarize attempt with no WebGPU must fail, not hang or crash").toBe("failed");
    expect(snap.error ?? "").toContain("webgpu");
    expect(snap.notices).toContain("notice.no_webgpu");
    expect(snap.bullets.length, "no bullets from a degraded attempt").toBe(0);

    expect(canaryHits).toEqual([]);
    expect(pageErrors).toEqual([]);

    const baseOrigin = new URL(page.url()).origin;
    const { violations, hubSeen } = evaluateAllowlist(records, allow, baseOrigin);
    expect(violations).toEqual([]);
    // Still only Kokoro: the failed probe happens before any summarizer file is requested.
    assertSetEqual(hubSeen, new Set(fileUrls(models.web.voice)), "wasm-ci degrade-clean check");

    console.log(`PRIVACY_WASM_CI_DEGRADE requests=${records.length} hub_files=${hubSeen.size}`);
  });

  test("webgpu-local: a full real run at every level -- no leaks, exact Hub set, CSP enforced, request log saved", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "webgpu-local", "webgpu-local only");
    // FIXME (S1-12, 2026-09-25): could not get this to complete in the dev sandbox. It needs
    // ~560 MB of real Hub downloads (default summarizer ~470 MB + Kokoro ~92 MB); this sandbox's
    // outbound bandwidth is shared with other agents' worktrees building concurrently (confirmed
    // via `ps aux`: S1-09 and S1-05 were both running their own real-network Playwright suites at
    // the same time) and measured as low as ~150 KB/s under that contention (curl range-GETs
    // against the same pinned Hub file URLs) -- ~560 MB at that rate is ~65 minutes for this one
    // test alone. Three attempts timed out at 9 min, then at a 15/35-min budget; a fourth was
    // cut short by the orchestrator's time-box before finishing. The logic itself is exercised
    // and passing on wasm-ci (below): same allowlist/redirect/canary code path, real Kokoro
    // download, just a smaller one. Re-run this test alone, uncontended, to get it green and
    // produce docs/qa/privacy-requests-<commit>.json; then remove this fixme.
    // The real-model sweep runs whenever this project is selected; it needs one uncontended
    // network (about 560 MB of pinned downloads) and writes docs/qa/privacy-requests-<commit>.json.
    test.setTimeout(45 * 60 * 1000);
    test.setTimeout(50 * 60 * 1000);

    const network = readJson<NetworkJson>("spec/network.json");
    const models = readJson<ModelsJson>("spec/models.json");
    const allow = buildAllowlist(network);
    await installStubs(page);
    const { records, canaryHits, pageErrors } = await attachRecorder(page);

    await gotoIsolated(page, "/"); // no ?llm=fake: real summarizer + real Kokoro
    await waitReady(page, 15 * 60_000); // Kokoro (~92 MB) under contended sandbox bandwidth

    for (const level of ["readall", "short", "caveman", "oneline"] as const) {
      // "short" downloads the default summarizer tier (~470 MB) on first use (rule 11); the other
      // levels reuse it from the browser's Cache Storage, so only "short" needs the long budget.
      const snap = await runLevel(page, level, level === "short" ? 35 * 60_000 : 5 * 60_000);
      expect(snap.gen, `level ${level} failed: ${snap.error ?? ""}`).toBe("done");
    }

    await assertCspBlocksOffList(page);

    expect(canaryHits).toEqual([]);
    expect(pageErrors).toEqual([]);

    const baseOrigin = new URL(page.url()).origin;
    const { violations, hubSeen } = evaluateAllowlist(records, allow, baseOrigin);
    expect(violations).toEqual([]);

    const expectedHub = new Set([...fileUrls(models.web.summarizer), ...fileUrls(models.web.voice)]);
    assertSetEqual(hubSeen, expectedHub, "webgpu-local full real sweep");
    // Sanity cross-check against S1-00b's own observed capture (network.json), independent of
    // how this test derived the expected set from spec/models.json.
    if (network.web.hub_files.observed_2026_09_24) {
      assertSetEqual(hubSeen, new Set(network.web.hub_files.observed_2026_09_24), "webgpu-local vs network.json observed_2026_09_24");
    }

    const commit = process.env.PRIVACY_COMMIT ?? execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
    const outPath = path.join(ROOT, "docs/qa", `privacy-requests-${commit}.json`);
    mkdirSync(path.dirname(outPath), { recursive: true });
    const hosts = [...new Set(records.map((r) => new URL(r.url).host))].sort();
    writeFileSync(
      outPath,
      JSON.stringify({ commit, capturedAt: new Date().toISOString(), requestCount: records.length, hubFilesRequested: [...hubSeen].sort(), hosts, records }, null, 2),
      "utf8",
    );
    expect(statSync(outPath).size, `${outPath} must be non-empty`).toBeGreaterThan(0);

    console.log(`PRIVACY_WEBGPU_LOCAL requests=${records.length} hub_files=${hubSeen.size} hosts=${JSON.stringify(hosts)} log=${path.relative(ROOT, outPath)}`);
  });
});
