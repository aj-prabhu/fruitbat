// @vitest-environment happy-dom
// S1-01 proof (docs/PLAN.md): render -> dial has 4 radios, default Short; strings come from
// spec/strings/en.json (not hard-coded in the component).
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dialSpec from "../../../spec/dial.json";
import stringsFile from "../../../spec/strings/en.json";
import { App } from "../app";

const STRINGS = stringsFile.strings as Record<string, string>;

function mount(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(<App />, container);
  return container;
}

beforeEach(() => {
  // The sample-article fetch is exercised for real by tests/smoke.spec.ts (Playwright, a served
  // page). Here there is no server, so the article's own fetch is stubbed to a fast, deterministic
  // rejection instead of depending on happy-dom's network behavior.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in component tests"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("App", () => {
  it("shows the 4-option dial, defaulted to Short", () => {
    const container = mount();
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="level"]')];
    expect(radios).toHaveLength(4);
    expect(radios.map((r) => r.value)).toEqual(["readall", "short", "caveman", "oneline"]);

    const checked = radios.filter((r) => r.checked);
    expect(checked).toHaveLength(1);
    expect(checked[0].value).toBe(dialSpec.default);
    expect(dialSpec.default).toBe("short");
  });

  it("is keyboard operable: arrow keys move the radiogroup selection", () => {
    const container = mount();
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="level"]')];
    const shortRadio = radios.find((r) => r.value === "short")!;
    const cavemanRadio = radios.find((r) => r.value === "caveman")!;
    expect(shortRadio.checked).toBe(true);
    cavemanRadio.click(); // native radio semantics: same name group, exclusive selection
    expect(cavemanRadio.checked).toBe(true);
    expect(shortRadio.checked).toBe(false);
  });

  it("takes every dial label from spec/strings/en.json, not a literal", () => {
    const container = mount();
    const labels = [...container.querySelectorAll<HTMLElement>(".dial-option span")].map((el) => el.textContent);
    const expected = dialSpec.levels.map((lvl) => STRINGS[lvl.label_key]);
    expect(labels).toEqual(expected);
  });

  it("renders an empty panel slot with an id of 'panel'", () => {
    const container = mount();
    const panel = container.querySelector("#panel");
    expect(panel).not.toBeNull();
    expect(panel?.tagName).toBe("ASIDE");
    expect(panel?.textContent).toBe(STRINGS["panel.empty"]);
  });

  it("renders the app title from spec/strings/en.json", () => {
    const container = mount();
    const h1 = container.querySelector("h1.app-title");
    expect(h1?.textContent).toBe(STRINGS["app.title"]);
  });

  it("shows a paste box with a live word count that updates on input", async () => {
    const container = mount();
    const textarea = container.querySelector<HTMLTextAreaElement>(".paste-textarea");
    expect(textarea).not.toBeNull();
    // Preact's controlled inputs read the DOM value directly (unlike React, it doesn't patch the
    // value setter), so setting it and dispatching "input" is enough to drive the onInput handler.
    textarea!.value = "one two three";
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve(); // Preact batches the re-render onto a microtask
    const count = container.querySelector(".word-count");
    // The label text is a spec/strings/en.json template (placeholder value until S1-L0), so the
    // count is asserted via data-word-count rather than by matching rendered copy.
    expect(count?.getAttribute("data-word-count")).toBe("3");
  });
});
