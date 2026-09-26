// The "Read" chip (docs/PLAN.md S1-02, Architecture -> "Intake" and "Panel"). Listens for
// mouseup/keyup selection changes on the whole document (which covers the article, since it's
// part of the document); shows a real <button> near the selection once it's >= 20 chars trimmed,
// within 100 ms; clicking it or pressing ⌥R runs the selection at the dial's current level; Esc
// or a collapsed selection hides it. All positioning math lives in ./selection so it stays
// unit-testable without a layout pass.
import { useEffect, useState } from "preact/hooks";
import { t } from "../strings";
import {
  type ChipPosition,
  chipPosition,
  currentSelectionText,
  hasRunnableSelection,
  isReadHotkey,
  meetsChipThreshold,
  runText,
  selectionRect,
} from "./selection";

interface ChipState {
  text: string;
  position: ChipPosition;
}

export function ReadChip() {
  const [chip, setChip] = useState<ChipState | null>(null);

  useEffect(() => {
    function syncFromSelection() {
      const text = currentSelectionText();
      if (!meetsChipThreshold(text)) {
        setChip(null);
        return;
      }
      const rect = selectionRect();
      if (!rect) {
        setChip(null);
        return;
      }
      setChip({ text, position: chipPosition(rect, window.innerWidth, window.innerHeight) });
    }

    function onKeyup(event: KeyboardEvent) {
      // Escape is a dismiss action, not a selection edit: the browser doesn't collapse the
      // selection on Escape, so if this handler re-ran syncFromSelection() here it would just
      // read the same still-there selection and immediately resurrect the chip onKeydown just
      // hid. Any other key (arrows, shift+arrows, etc.) does mean "the selection may have
      // changed" and should resync as usual.
      if (event.key === "Escape") return;
      syncFromSelection();
    }

    function onKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setChip(null);
        return;
      }
      if (isReadHotkey(event) && hasRunnableSelection()) {
        event.preventDefault();
        runText(currentSelectionText());
        setChip(null);
      }
    }

    document.addEventListener("mouseup", syncFromSelection);
    document.addEventListener("keyup", onKeyup);
    document.addEventListener("keydown", onKeydown);
    // The chip is fixed-position: keep it next to the selection when the page scrolls or resizes
    // (Codex merge-gate review, PR #12).
    window.addEventListener("scroll", syncFromSelection, { passive: true, capture: true });
    window.addEventListener("resize", syncFromSelection);
    return () => {
      document.removeEventListener("mouseup", syncFromSelection);
      document.removeEventListener("keyup", onKeyup);
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("scroll", syncFromSelection, { capture: true });
      window.removeEventListener("resize", syncFromSelection);
    };
  }, []);

  if (!chip) return null;

  return (
    <button
      type="button"
      class="read-chip"
      style={{ left: `${chip.position.left}px`, top: `${chip.position.top}px` }}
      aria-label={t("panel.read_chip")}
      // Keep the selection alive through the click (a mousedown on the button would otherwise
      // collapse it in most browsers before onClick fires); harmless for keyboard activation,
      // which never fires mousedown.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        runText(chip.text);
        setChip(null);
      }}
    >
      {t("panel.read_chip")}
    </button>
  );
}
