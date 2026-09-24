// The two state machines of the pipeline (docs/PLAN.md S1-06; Architecture -> "Concurrency
// model"): generation and playback are independent. Pure reducers over an exhaustive table:
// every state lists the events it accepts; an event a state does not list is a no-op, never a
// throw, so a late worker message can never corrupt the state (Cancellation: stale results are
// dropped). The orchestrator is the only writer; the UI only reads snapshots.

export type GenState = "idle" | "loading" | "running" | "done" | "failed";
export type GenEvent = "start" | "loaded" | "finish" | "fail" | "stop";
export type PlayState = "idle" | "playing" | "paused" | "stopped";
export type PlayEvent = "audio" | "pause" | "resume" | "stop" | "drain" | "reset";

export const GEN_STATES: readonly GenState[] = ["idle", "loading", "running", "done", "failed"];
export const GEN_EVENTS: readonly GenEvent[] = ["start", "loaded", "finish", "fail", "stop"];
export const PLAY_STATES: readonly PlayState[] = ["idle", "playing", "paused", "stopped"];
export const PLAY_EVENTS: readonly PlayEvent[] = ["audio", "pause", "resume", "stop", "drain", "reset"];

/** gen: a run starts by loading (probe + download on demand), runs, and ends done or failed.
 *  `stop` returns to idle from anywhere; `start` is legal only from a settled state (the
 *  orchestrator always emits `stop` before `start`, so a new input never overlaps a run). */
export const GEN_TABLE: Readonly<Record<GenState, Partial<Record<GenEvent, GenState>>>> = {
  idle: { start: "loading", stop: "idle" },
  loading: { loaded: "running", fail: "failed", stop: "idle" },
  running: { finish: "done", fail: "failed", stop: "idle" },
  done: { start: "loading", stop: "idle" },
  failed: { start: "loading", stop: "idle" },
};

/** play: idle until the first audio sample is scheduled; pause/resume; `stop` from anywhere
 *  (Esc, ≤ 200 ms); `drain` when the last scheduled item has played; `reset` when a new run
 *  begins. `audio` while paused is a no-op (the queue keeps scheduling, the clock is stopped). */
export const PLAY_TABLE: Readonly<Record<PlayState, Partial<Record<PlayEvent, PlayState>>>> = {
  idle: { audio: "playing", stop: "stopped", reset: "idle" },
  playing: { audio: "playing", pause: "paused", stop: "stopped", drain: "idle", reset: "idle" },
  paused: { resume: "playing", stop: "stopped", drain: "idle", reset: "idle" },
  stopped: { audio: "playing", stop: "stopped", reset: "idle" },
};

export function reduceGen(state: GenState, event: GenEvent): GenState {
  return GEN_TABLE[state][event] ?? state;
}
export function reducePlay(state: PlayState, event: PlayEvent): PlayState {
  return PLAY_TABLE[state][event] ?? state;
}
export function canGen(state: GenState, event: GenEvent): boolean {
  return GEN_TABLE[state][event] !== undefined;
}
export function canPlay(state: PlayState, event: PlayEvent): boolean {
  return PLAY_TABLE[state][event] !== undefined;
}

/** A run is active when generation or playback is still going: the dial regenerates instead of
 *  merely re-arming, and Esc has something to stop. */
export function isActive(gen: GenState, play: PlayState): boolean {
  return gen === "loading" || gen === "running" || play === "playing" || play === "paused";
}
