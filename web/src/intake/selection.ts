// Pure selection-handling helpers for the "Read" chip and the ⌥R hotkey (docs/PLAN.md S1-02,
// Architecture -> "Intake": "the sample article on the page (select -> 'Read' chip, or ⌥R)").
// Kept free of Preact/component concerns on purpose: everything here is a plain function over
// `window.getSelection()` / a `KeyboardEvent`, so it's unit-testable in plain Node (no DOM) and
// the DOM wiring in ReadChip.tsx stays thin.
import { getLevel } from "../state/level";

/** The chip only appears once the (trimmed) selection reaches this length (Build spec). */
export const MIN_SELECTION_CHARS = 20;

export interface ChipPosition {
  left: number;
  top: number;
}

// Approximate chip footprint used only to keep it inside the viewport without a layout read
// before first paint (docs/PLAN.md: "within 100 ms"). A little slack here costs nothing; the
// chip is small and short-lived.
const CHIP_WIDTH = 96;
const CHIP_HEIGHT = 36;
const CHIP_MARGIN = 8;

/** The current window selection's trimmed text, or "" if there is none / it's collapsed. */
export function currentSelectionText(): string {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
  return sel.toString().trim();
}

/** ⌥R runs "while a selection exists" (Build spec) -- no 20-char floor, unlike the chip. */
export function hasRunnableSelection(): boolean {
  return currentSelectionText().length > 0;
}

/** Whether `text` (already the live selection's trimmed string) is long enough to show the chip. */
export function meetsChipThreshold(text: string): boolean {
  return text.trim().length >= MIN_SELECTION_CHARS;
}

/** The current selection's bounding rect in viewport coordinates, or null if there isn't one. */
export function selectionRect(): DOMRect | null {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.rangeCount === 0) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return rect;
}

/**
 * Where to place the chip: just below the selection's bounding rect, flipped above when there's
 * no room below, and clamped so it never leaves the viewport. Because the chip always sits
 * vertically outside the rect (above it or below it, never inside its vertical span), it can
 * never cover the selection horizontally either -- except in the extreme case of a selection tall
 * enough to leave no margin on either side, which the sample article and paste box never produce.
 */
export function chipPosition(rect: DOMRect, viewportWidth: number, viewportHeight: number): ChipPosition {
  let top = rect.bottom + CHIP_MARGIN;
  if (top + CHIP_HEIGHT > viewportHeight) {
    top = rect.top - CHIP_HEIGHT - CHIP_MARGIN;
  }
  top = Math.max(CHIP_MARGIN, Math.min(top, viewportHeight - CHIP_HEIGHT - CHIP_MARGIN));

  const left = Math.max(CHIP_MARGIN, Math.min(rect.left, viewportWidth - CHIP_WIDTH - CHIP_MARGIN));

  return { left, top };
}

/** The ⌥R hotkey matcher (docs/PLAN.md C2: web hotkey is ⌥R / Alt+R). */
export function isReadHotkey(event: Pick<KeyboardEvent, "code" | "altKey">): boolean {
  return event.altKey && event.code === "KeyR";
}

/** Run `text` through the pipeline at the dial's current level (all intake paths funnel here). */
export function runText(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  window.__fruitbat.run(trimmed, getLevel());
}
