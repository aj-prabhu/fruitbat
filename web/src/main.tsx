// Entry point for the real app (index.html -> main.tsx -> app.tsx). Sets up the
// window.__fruitbat test hook before rendering (docs/PLAN.md S1-01) and applies a
// previously-persisted theme immediately, so the panel and the dial exist before any
// dial/pipeline packet lands. S1-06 wires the `fruitbat:run` / `fruitbat:stop` events to the
// orchestrator, which owns the pipeline (engine/orchestrator.ts).
import { render } from "preact";
import { App } from "./app";
import { orchestrator } from "./engine/orchestrator";
import { isActive } from "./engine/state";
import { subscribeLevel } from "./state/level";
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
};
window.__fruitbat = fruitbat;
window.addEventListener("fruitbat:run", (e) => void o.run(e.detail.text, e.detail.level));
window.addEventListener("fruitbat:stop", () => o.stop());
// The demo recording is about to play: silence a live read or summary, but leave a summarizer
// download the user started from the Loading panel alone (Codex review, PR #20).
window.addEventListener("fruitbat:demo", () => {
  const s = o.snapshot();
  // Speech still on its way (a summary whose generation finished before its first bullet was
  // synthesized) counts too (Codex review, PR #20).
  const speechPending = s.voice.pending > 0 || s.voice.inFlight > 0 || s.voice.enqueued > s.voice.ended;
  if (isActive(s.gen, s.play) || speechPending) o.stop({ quiet: true });
  else o.silenceVoice(); // e.g. the "Stopped" an Esc just spoke must not play under the recording
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
