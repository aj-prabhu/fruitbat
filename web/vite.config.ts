import { defineConfig } from "vite";

// Stage 1 is a static site: no dev-server headers for cross-origin isolation.
// The COOP/COEP headers come from public/coi-serviceworker.js so that `vite preview`
// behaves like the static Hugging Face Space (which cannot set headers).
export default defineConfig({
  build: {
    target: "esnext",
    manifest: true,
    sourcemap: false,
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@huggingface/transformers", "phonemizer"] },
});
