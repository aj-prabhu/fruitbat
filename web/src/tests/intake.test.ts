// S1-02 unit proof (docs/PLAN.md, Build): a Vitest unit test for the word count and for the ⌥R
// key matcher. Plain functions, plain Node -- no DOM environment needed.
import { describe, expect, it } from "vitest";
import { wordCount } from "../intake/paste";
import { chipPosition, isReadHotkey, meetsChipThreshold } from "../intake/selection";

describe("wordCount", () => {
  it("counts whitespace-separated words", () => {
    expect(wordCount("one two three")).toBe(3);
  });

  it("is 0 for empty or whitespace-only text", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   \n\t  ")).toBe(0);
  });

  it("collapses runs of whitespace, including newlines, into single breaks", () => {
    expect(wordCount("one   two\nthree\n\nfour")).toBe(4);
  });

  it("ignores leading/trailing whitespace", () => {
    expect(wordCount("  one two  ")).toBe(2);
  });
});

describe("isReadHotkey (⌥R)", () => {
  it("matches Alt+KeyR", () => {
    expect(isReadHotkey({ code: "KeyR", altKey: true })).toBe(true);
  });

  it("rejects KeyR without Alt", () => {
    expect(isReadHotkey({ code: "KeyR", altKey: false })).toBe(false);
  });

  it("rejects Alt held with a different key", () => {
    expect(isReadHotkey({ code: "KeyS", altKey: true })).toBe(false);
  });

  it("is layout-independent (keys on `code`, not the shifted/localized `key`)", () => {
    // event.code is physical-key based, so this holds even under non-US/AZERTY layouts, per the
    // Build spec's exact matcher (event.code === "KeyR" && event.altKey).
    expect(isReadHotkey({ code: "KeyR", altKey: true })).toBe(true);
  });
});

describe("meetsChipThreshold", () => {
  it("is false under the 20-char floor", () => {
    expect(meetsChipThreshold("short text")).toBe(false); // 10 chars
  });

  it("is true at exactly 20 trimmed chars", () => {
    expect(meetsChipThreshold("a".repeat(20))).toBe(true);
  });

  it("is false at 19 trimmed chars", () => {
    expect(meetsChipThreshold("a".repeat(19))).toBe(false);
  });

  it("trims before counting", () => {
    expect(meetsChipThreshold(`   ${"a".repeat(20)}   `)).toBe(true);
  });
});

describe("chipPosition", () => {
  const viewport = { width: 800, height: 600 };

  it("places the chip below the selection when there's room", () => {
    const rect = { top: 100, bottom: 120, left: 50, right: 200 } as DOMRect;
    const pos = chipPosition(rect, viewport.width, viewport.height);
    expect(pos.top).toBeGreaterThan(rect.bottom);
  });

  it("flips above the selection when there's no room below", () => {
    const rect = { top: 550, bottom: 590, left: 50, right: 200 } as DOMRect;
    const pos = chipPosition(rect, viewport.width, viewport.height);
    expect(pos.top).toBeLessThan(rect.top);
  });

  it("clamps horizontally inside the viewport", () => {
    const rect = { top: 100, bottom: 120, left: 780, right: 900 } as DOMRect;
    const pos = chipPosition(rect, viewport.width, viewport.height);
    expect(pos.left).toBeGreaterThanOrEqual(0);
    expect(pos.left).toBeLessThan(viewport.width);
  });

  it("never lands inside the selection's own vertical span", () => {
    const rect = { top: 100, bottom: 120, left: 50, right: 200 } as DOMRect;
    const pos = chipPosition(rect, viewport.width, viewport.height);
    expect(pos.top < rect.top || pos.top > rect.bottom).toBe(true);
  });
});
