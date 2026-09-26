import { defineConfig } from "vitest/config";

// Unit tests run in Node. The pinned tokenizer is fetched once through net.ts (the real
// allowlist) and cached under web/.cache/hf, so a second run is offline.
export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    env: { FRUITBAT_HF_CACHE: ".cache/hf" },
  },
});
