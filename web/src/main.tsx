// Entry point for the real app (index.html -> main.tsx -> app.tsx). Sets up the
// window.__fruitbat test hook before rendering (docs/PLAN.md S1-01) and applies a
// previously-persisted theme immediately, so the panel and the dial exist before any
// dial/pipeline packet lands. S1-06 owns everything the `fruitbat:run` / `fruitbat:stop`
// events trigger; this file only records the request and counts it, per spec.
import { render } from "preact";
import { App } from "./app";
import type { FruitbatAPI, FruitbatStats, Level, RunRequest } from "./types";
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

let runs = 0;
let last: RunRequest | null = null;

const fruitbat: FruitbatAPI = {
  run(text: string, level: Level) {
    runs += 1;
    last = { level, chars: text.length };
    window.dispatchEvent(new CustomEvent("fruitbat:run", { detail: { text, level } }));
  },
  stop() {
    window.dispatchEvent(new CustomEvent("fruitbat:stop"));
  },
  stats(): FruitbatStats {
    return { runs, last };
  },
};
window.__fruitbat = fruitbat;

applyStoredTheme();

const root = document.getElementById("app");
if (root) render(<App />, root);
