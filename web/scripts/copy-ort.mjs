// Copy onnxruntime-web's WASM runtime into public/ort/ so it is served same-origin.
// Without this, Transformers.js loads it from a CDN, which is an outbound destination
// that spec/network.json does not allow (docs/PLAN.md rule 1). Runs as `prebuild`.
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "node_modules", "onnxruntime-web", "dist");
const dst = path.join(here, "..", "public", "ort");
await mkdir(dst, { recursive: true });
const wanted = (await readdir(src)).filter((f) => /^ort-wasm-simd-threaded.*\.(mjs|wasm)$/.test(f) && !f.endsWith(".map"));
for (const f of wanted) await copyFile(path.join(src, f), path.join(dst, f));
process.stdout.write(`copy-ort: ${wanted.length} files -> public/ort/\n`);
