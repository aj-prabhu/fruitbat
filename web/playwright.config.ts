import { defineConfig, devices } from "@playwright/test";

// Two projects (docs/PLAN.md, S1-00a; S1-01 extends this file):
//   wasm-ci      headless bundled Chromium, WebGPU off. What CI runs. Specs that need the LLM use
//                `?llm=fake` (S1-05) or skip.
//   webgpu-local headed bundled Chromium with WebGPU, audio muted. Run by hand on the dev machine
//                and by the bench. Never the agent Chrome profile.
// BASE_URL=https://… runs the same specs against a deployed Space (S1-00b) instead of `vite preview`.
// PW_PORT lets parallel worktrees each run their own preview server; a server is never reused,
// because reusing another worktree's build silently tests the wrong code (found 2026-09-24).
const port = Number(process.env.PW_PORT ?? 4173);
const baseURL = process.env.BASE_URL ?? `http://localhost:${port}`;
const commonArgs = ["--autoplay-policy=no-user-gesture-required", "--mute-audio"];

export default defineConfig({
  testDir: "tests",
  // S1-13a: fills web/.cache/models/ (spec/models.json web.voice; +web.summarizer when
  // MODEL_CACHE_FULL=1) once per run, before any project's tests start. tests/model-cache.ts's
  // `test` fixture then routes Hub requests to those cached files. Idempotent -- a warm cache
  // makes this a fast no-op check, not a re-download.
  globalSetup: "./tests/model-cache.ts",
  timeout: 10 * 60 * 1000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL, trace: "retain-on-failure" },
  webServer: process.env.BASE_URL
    ? undefined
    : {
        // S1-13a: tests/dev-proxy.mjs fronts `vite preview` (on port+10000, internal) so
        // /__model_cache__/** can serve a large cached model file at a SAME-ORIGIN path --
        // route.fulfill() crashes the browser for a body this size (see dev-proxy.mjs's header
        // comment). Everything else passes through to vite preview unchanged.
        command: `npm run build && node tests/dev-proxy.mjs ${port} ${port + 10000}`,
        url: `http://localhost:${port}`,
        reuseExistingServer: false,
        timeout: 180_000,
      },
  projects: [
    {
      name: "wasm-ci",
      use: {
        ...devices["Desktop Chrome"],
        headless: true,
        launchOptions: { args: ["--disable-blink-features=WebGPU", ...commonArgs] },
      },
    },
    {
      name: "webgpu-local",
      use: {
        ...devices["Desktop Chrome"],
        headless: false,
        launchOptions: { args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", ...commonArgs] },
      },
    },
  ],
});
