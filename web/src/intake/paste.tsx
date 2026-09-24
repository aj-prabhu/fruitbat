// The paste box (docs/PLAN.md S1-02, Architecture -> "Intake"). Moved out of app.tsx, which had
// only the skeleton version (S1-01: textarea + word count, no run path). Adds a "Read this"
// button (disabled when empty) and Cmd/Ctrl+Enter, both calling run(text, level) at the dial's
// current level through the same helper the selection chip uses.
import { useState } from "preact/hooks";
import { t } from "../strings";
import { runText } from "./selection";

/** Whitespace-separated word count, "" / whitespace-only counts as 0. Exported for its unit test. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

export function PasteBox() {
  const [value, setValue] = useState("");
  const count = wordCount(value);
  const isEmpty = value.trim() === "";

  function submit() {
    if (isEmpty) return;
    runText(value);
  }

  return (
    <div class="paste-box">
      <label class="paste-label" for="paste-input">
        {t("intake.paste_placeholder")}
      </label>
      <textarea
        id="paste-input"
        class="paste-textarea"
        placeholder={t("intake.paste_placeholder")}
        value={value}
        onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div class="paste-row">
        <p class="word-count" aria-live="polite" data-word-count={count}>
          {t("intake.word_count").replace("{n}", String(count))}
        </p>
        <button type="button" class="read-button" onClick={submit} disabled={isEmpty}>
          {t("intake.read_button")}
        </button>
      </div>
    </div>
  );
}
