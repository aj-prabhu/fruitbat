import { describe, expect, it } from "vitest";
import {
  GEN_EVENTS,
  GEN_STATES,
  GEN_TABLE,
  PLAY_EVENTS,
  PLAY_STATES,
  PLAY_TABLE,
  canGen,
  canPlay,
  isActive,
  reduceGen,
  reducePlay,
  type GenState,
  type PlayState,
} from "../engine/state";

describe("gen state machine", () => {
  it("has a row for every state and every transition lands in a known state", () => {
    for (const s of GEN_STATES) {
      expect(GEN_TABLE[s]).toBeDefined();
      for (const e of GEN_EVENTS) {
        const next = reduceGen(s, e);
        expect(GEN_STATES).toContain(next);
        expect(canGen(s, e) ? GEN_TABLE[s][e] : s).toBe(next);
      }
    }
  });
  it("stop is legal from every state and always ends idle", () => {
    for (const s of GEN_STATES) expect(reduceGen(s, "stop")).toBe("idle");
  });
  it("start is legal only from a settled state", () => {
    expect(canGen("idle", "start")).toBe(true);
    expect(canGen("done", "start")).toBe(true);
    expect(canGen("failed", "start")).toBe(true);
    expect(canGen("loading", "start")).toBe(false);
    expect(canGen("running", "start")).toBe(false);
  });
  it("walks the happy path and the failure paths", () => {
    let s: GenState = "idle";
    for (const [e, expected] of [
      ["start", "loading"],
      ["loaded", "running"],
      ["finish", "done"],
      ["start", "loading"],
      ["fail", "failed"],
      ["start", "loading"],
      ["stop", "idle"],
    ] as const) {
      s = reduceGen(s, e);
      expect(s).toBe(expected);
    }
    expect(reduceGen("running", "fail")).toBe("failed");
  });
  it("drops a late event as a no-op instead of corrupting the state", () => {
    expect(reduceGen("idle", "finish")).toBe("idle"); // chunk_done after stop
    expect(reduceGen("idle", "loaded")).toBe("idle"); // loaded after stop
    expect(reduceGen("done", "finish")).toBe("done");
    expect(reduceGen("failed", "loaded")).toBe("failed");
  });
});

describe("play state machine", () => {
  it("has a row for every state and every transition lands in a known state", () => {
    for (const s of PLAY_STATES) {
      expect(PLAY_TABLE[s]).toBeDefined();
      for (const e of PLAY_EVENTS) {
        const next = reducePlay(s, e);
        expect(PLAY_STATES).toContain(next);
        expect(canPlay(s, e) ? PLAY_TABLE[s][e] : s).toBe(next);
      }
    }
  });
  it("stop is legal from every state and always ends stopped; reset always ends idle", () => {
    for (const s of PLAY_STATES) {
      expect(reducePlay(s, "stop")).toBe("stopped");
      expect(reducePlay(s, "reset")).toBe("idle");
    }
  });
  it("pause/resume only make sense while audio is going", () => {
    let s: PlayState = "idle";
    s = reducePlay(s, "pause");
    expect(s).toBe("idle");
    s = reducePlay(s, "audio");
    expect(s).toBe("playing");
    s = reducePlay(s, "pause");
    expect(s).toBe("paused");
    expect(reducePlay(s, "audio")).toBe("paused"); // scheduling continues, the clock does not
    s = reducePlay(s, "resume");
    expect(s).toBe("playing");
    s = reducePlay(s, "drain");
    expect(s).toBe("idle");
  });
  it("a stopped run can start playing again (Read this part after Esc)", () => {
    expect(reducePlay("stopped", "audio")).toBe("playing");
    expect(reducePlay("stopped", "resume")).toBe("stopped");
  });
});

describe("isActive", () => {
  it("is true while generating or while audio plays or is paused", () => {
    expect(isActive("idle", "idle")).toBe(false);
    expect(isActive("done", "idle")).toBe(false);
    expect(isActive("done", "stopped")).toBe(false);
    expect(isActive("loading", "idle")).toBe(true);
    expect(isActive("running", "idle")).toBe(true);
    expect(isActive("done", "playing")).toBe(true);
    expect(isActive("done", "paused")).toBe(true);
  });
});
