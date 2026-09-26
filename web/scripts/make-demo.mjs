#!/usr/bin/env node
// Regenerate the canned demo (docs/PLAN.md S1-09): web/public/demo/{readall,short,caveman,oneline}.{json,wav}.
// Plain `node web/scripts/make-demo.mjs`. The real work needs two Node flags (TypeScript
// parameter-property syntax in web/src/core/*.ts, and a loader hook that lets a plain Node
// script import those .ts files the way Vite does -- see scripts/lib/ts-resolve-loader.mjs), so
// this file's only job is to re-exec itself with those flags once, then run the real script.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.FRUITBAT_DEMO_REEXEC) {
  const loader = new URL("./lib/ts-resolve-loader.mjs", import.meta.url).href;
  const main = fileURLToPath(new URL("./lib/make-demo-main.mjs", import.meta.url));
  const res = spawnSync(process.execPath, ["--experimental-transform-types", "--experimental-loader", loader, main, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, FRUITBAT_DEMO_REEXEC: "1" },
  });
  process.exit(res.status === null ? 1 : res.status);
}
