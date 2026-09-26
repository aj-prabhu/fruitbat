// Vitest setup for component tests (docs/PLAN.md S1-01). Only runs for files that opt into a DOM
// environment (`// @vitest-environment happy-dom`); plain-Node unit tests (tokens/net/loader)
// never load this. Clears the DOM between tests so one component test can't leak into the next.
import { afterEach } from "vitest";

// setupFiles runs for every test file regardless of environment (tokens/net/loader run in plain
// Node, with no `document`), so this is a no-op there.
if (typeof document !== "undefined") {
  afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-theme");
  });
}
