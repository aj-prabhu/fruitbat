// Entry point for the real app (index.html -> main.tsx -> app.tsx). Sets up the
// window.__fruitbat test hook before rendering (docs/PLAN.md S1-01) and applies a
// previously-persisted theme immediately, so the panel and the dial exist before any
// dial/pipeline packet lands. S1-06 wires the `fruitbat:run` / `fruitbat:stop` events to the
// orchestrator, which owns the pipeline (engine/orchestrator.ts).
import { render } from "preact";
import { App } from "./app";
import { orchestrator } from "./engine/orchestrator";
import { subscribeLevel } from "./state/level";
import * as stats from "./stats/store";
import type { FruitbatAPI, FruitbatStats, Level } from "./types";
import "./styles/global.css";

function applyStoredTheme(): void {
  try {
    const saved = localStorage.getItem("fruitbat-theme");
    if (saved === "dark" || saved === "light") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch {
    // private browsing / blocked storage: fall back to prefers-color-scheme via CSS
  }
}

// S1-06: the orchestrator owns the pipeline. run/stop keep firing the S1-01 events (intake and
// tests listen for them); the orchestrator is the one listener that acts.
const o = orchestrator();

const fruitbat: FruitbatAPI = {
  run(text: string, level: Level) {
    window.dispatchEvent(new CustomEvent("fruitbat:run", { detail: { text, level } }));
  },
  stop() {
    window.dispatchEvent(new CustomEvent("fruitbat:stop"));
  },
  stats(): FruitbatStats {
    return o.stats();
  },
  state: () => o.snapshot(),
  setLevel: (level: Level) => o.setLevel(level),
  readThisPart: (i: number) => o.readThisPart(i),
  pause: () => o.pause(),
  resume: () => o.resume(),
  skip: () => o.skip(),
  setSpeakMessages: (on: boolean) => o.setSpeakMessages(on),
  rows: () => stats.rows(),
  setDocId: (id: string) => stats.setDocId(id),
};
window.__fruitbat = fruitbat;
window.addEventListener("fruitbat:run", (e) => void o.run(e.detail.text, e.detail.level));
window.addEventListener("fruitbat:stop", () => o.stop());
// S1-10: one RunStats row per finished run (done or failed), never on stop -- a stopped run never
// finished (docs/PLAN.md "Stats store"). `runId` is monotonic and never reused, so recording once
// per (runId, terminal-gen) pair is enough to survive later emits of the same terminal state
// (e.g. a spoken "notice.done" that fires after gen is already "done").
let lastRecordedRunId = 0;
o.subscribe((snap) => {
  // gen turns terminal before the summary's speech has played; record once the voice has drained
  // too, so the row carries the voice metrics (Codex review, PR #22).
  const voiceIdle = snap.play !== "playing" && snap.play !== "paused" && snap.voice.inFlight === 0 && snap.voice.enqueued <= snap.voice.ended;
  if ((snap.gen === "done" || snap.gen === "failed") && voiceIdle && snap.runId !== lastRecordedRunId) {
    lastRecordedRunId = snap.runId;
    stats.record(o.stats());
  }
});
// The dial (app.tsx) writes state/level; a move mid-run regenerates from the current chunk.
subscribeLevel((level) => void o.setLevel(level));
// Esc is handled on the main thread and never waits on a worker (Architecture, Concurrency).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") o.stop();
});

applyStoredTheme();

const root = document.getElementById("app");
if (root) render(<App />, root);
