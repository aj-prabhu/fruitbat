import { describe, expect, it, vi } from "vitest";
import fixture from "../../../spec/fixtures/tokens.web.json";
import { countTokens, countTokensWith, tokenizerReady } from "../core/tokens";
import { summarizerTiers } from "../engine/pins";

describe("tokens", () => {
  it("loads the pinned tokenizer through net.ts with no unpinned URL", async () => {
    const seen: string[] = [];
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return real(input, init);
    });
    try {
      const tok = await tokenizerReady();
      expect(tok).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
    // Cold run: every URL is a pinned Hub file. Warm run (FS cache): no requests at all.
    for (const u of seen) {
      expect(u, "every request is pinned").not.toMatch(/\/resolve\/main\//);
      expect(u).toMatch(/^https:\/\/huggingface\.co\/onnx-community\/Qwen3\.5-0\.8B-Text-ONNX\/resolve\/1e45daba048899e7f771657ada617ec49350aa91\//);
    }
  });

  it("matches the frozen fixture counts", async () => {
    expect(fixture.entries).toHaveLength(5);
    for (const { text, tokens } of fixture.entries) {
      expect(await countTokens(text), JSON.stringify(text.slice(0, 40))).toBe(tokens);
    }
  });

  it("counts an empty string as 0 without special tokens", async () => {
    expect(await countTokens("")).toBe(0);
  });

  it("a fallback tier gets its own tokenizer, so budgets match the model that reads them", async () => {
    const low = summarizerTiers().find((t) => t.role === "low-end")!;
    const [def, lowTok] = await Promise.all([tokenizerReady(), tokenizerReady(low)]);
    expect(lowTok).not.toBe(def);
    expect(await tokenizerReady(low)).toBe(lowTok); // cached per model
    const text = "Fruit bats pollinate figs and disperse seeds across 30 kilometres of forest.";
    expect(await countTokens(text, low)).toBe(countTokensWith(lowTok, text));
  }, 120_000);
});
