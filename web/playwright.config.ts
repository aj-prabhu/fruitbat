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
        command: `npm run build && npx vite preview --port ${port} --strictPort`,
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
