import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

// Stage 1 is a static site: no dev-server headers for cross-origin isolation.
// The COOP/COEP headers come from public/coi-serviceworker.js so that `vite preview`
// behaves like the static Hugging Face Space (which cannot set headers).
//
// Two build entries (S1-01, docs/PLAN.md): `index.html` is the real app (main.tsx -> app.tsx);
// `skeleton.html` keeps S1-00a's walking skeleton alive unchanged, loading src/skeleton.ts, so
// tests/skeleton.spec.ts keeps proving the pinned runtime end to end. Vite 8.3 renamed
// `build.rollupOptions` to `build.rolldownOptions` (rollupOptions is now a deprecated alias);
// this uses the new key directly.

// stats/store.ts's StatsRow.commit (S1-10): the short commit this build was made from, falling
// back to "dev" when git is unavailable at build time (a from-scratch checkout with no .git, some
// CI images). Vitest runs from its own config with no such `define`, so store.ts guards the
// global with `typeof` rather than assuming it exists.
function buildCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  plugins: [preact()],
  define: {
    __FRUITBAT_COMMIT__: JSON.stringify(buildCommit()),
  },
  build: {
    target: "esnext",
    manifest: true,
    sourcemap: false,
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        skeleton: fileURLToPath(new URL("./skeleton.html", import.meta.url)),
        readall: fileURLToPath(new URL("./readall.html", import.meta.url)), // S1-04 harness
        summarize: fileURLToPath(new URL("./summarize.html", import.meta.url)), // S1-05 harness
      },
    },
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@huggingface/transformers", "phonemizer"] },
});
