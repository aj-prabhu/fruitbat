// The dial's current level, readable outside app.tsx (docs/PLAN.md S1-02, Build: "expose a small
// store web/src/state/level.ts that app.tsx writes and intake reads"). Deliberately not a Preact
// signal/context: intake's listeners (selection.ts) are plain DOM event handlers with no
// component tree of their own, so a module-scoped value plus a subscribe list is the smallest
// thing that lets app.tsx's <Dial> stay the single source of truth while intake reads it
// synchronously (no re-render needed to answer "what level is selected right now").
import dialSpec from "../../../spec/dial.json";
import type { Level } from "../types";

// The default comes from the spec, never from code (docs/PLAN.md rule 7).
const DEFAULT_LEVEL: Level = (dialSpec.default as Level) ?? "short";

let current: Level = DEFAULT_LEVEL;
const listeners = new Set<(level: Level) => void>();

/** The dial's current level. Always in sync with app.tsx's own state (app.tsx writes on change). */
export function getLevel(): Level {
  return current;
}

/** Called by app.tsx whenever the dial's selection changes (including its initial mount). */
export function setLevel(level: Level): void {
  if (level === current) return;
  current = level;
  for (const fn of listeners) fn(current);
}

/** Subscribe to level changes; returns an unsubscribe function. Unused by S1-02 itself today
 * (intake reads getLevel() at run time, not on every change) but kept small and here for S1-07/
 * S1-09, which do need to react to dial changes (e.g. speaking the dial-change notice). */
export function subscribeLevel(fn: (level: Level) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
