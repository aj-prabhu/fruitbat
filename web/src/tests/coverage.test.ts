import { describe, expect, it } from "vitest";
import { coverageOf } from "../engine/tts";

describe("coverageOf", () => {
  const text = "One two. Three four.";
  it("is 1 only when segments tile the source", () => {
    expect(coverageOf(text, [{ start: 0, end: 8 }, { start: 9, end: 20 }])).toBe(1);
  });
  it("a gap reports the share read, below 1", () => {
    const c = coverageOf(text, [{ start: 0, end: 8 }]);
    expect(c).toBeLessThan(1);
    expect(c).toBeCloseTo(7 / 17, 5); // "One two." holds 7 of the 17 non-whitespace characters
  });
  it("an overlap never reports 1.0, even though every character was read", () => {
    const c = coverageOf(text, [{ start: 0, end: 12 }, { start: 9, end: 20 }]);
    expect(c).toBeLessThan(1);
  });
});
