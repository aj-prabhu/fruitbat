import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

// Unit tests run in Node by default. The pinned tokenizer is fetched once through net.ts (the
// real allowlist) and cached under web/.cache/hf, so a second run is offline. Component tests
// (src/tests/*.test.tsx, S1-01) opt into a DOM environment per file with a
// `// @vitest-environment happy-dom` docblock, so the tokenizer/net/loader tests keep running in
// plain Node.
export default defineConfig({
  plugins: [preact()],
  // The spec folder is the source of truth (rule 7): prompts and word lists are imported with
  // `?raw` from ../spec, outside the web root, so the test server must be allowed to read it.
  server: { fs: { allow: [".."] } },
  test: {
    include: ["src/tests/**/*.test.ts", "src/tests/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    env: { FRUITBAT_HF_CACHE: ".cache/hf" },
  },
});
