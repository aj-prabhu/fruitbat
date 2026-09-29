#!/usr/bin/env node
// Summary-quality run on CPU in Node: the production chunk → prompt → parse → ground path from
// web/src/core against the pinned summarizer (cpu_tryout dtype), scored with bench/score.py plus
// compression, tail coverage, copy rate and cut rate. See scripts/lib/quality-cpu-main.mjs.
//   node web/scripts/quality-cpu.mjs --docs 005,011 --levels short --out /tmp/q --tag before
// Same re-exec shim as make-demo.mjs: the real script needs --experimental-transform-types and
// the ts-resolve-loader hook to import web/src/core/*.ts.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.FRUITBAT_QUALITY_REEXEC) {
  const loader = new URL("./lib/ts-resolve-loader.mjs", import.meta.url).href;
  const main = fileURLToPath(new URL("./lib/quality-cpu-main.mjs", import.meta.url));
  const res = spawnSync(process.execPath, ["--no-warnings", "--experimental-transform-types", "--experimental-loader", loader, main, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, FRUITBAT_QUALITY_REEXEC: "1" },
  });
  process.exit(res.status === null ? 1 : res.status);
}
