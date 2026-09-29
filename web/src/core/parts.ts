// Part-by-part summarizing (spec/chunking.md "Parts"). A level with `part_tokens` in
// spec/dial.json does not ask the model for N bullets over a whole chunk: the pinned 0.8B model
// ignores bullet counts and copies the chunk sentence by sentence, so the parser cap kept only the
// chunk's opening sentences and dropped its end (docs/qa/short-quality-2026-09-29.md). Instead the
// chunk's sentences are split into contiguous parts of about equal length and the model writes
// one line per part, so every part of the chunk gets a line by construction.

import type { Segment } from "./segment";

export interface PartCaps {
  part_tokens: number;
  min_bullets_per_chunk: number;
  max_bullets_per_chunk: number;
}

/** How many parts a chunk of `tokens` tokens and `sentences` sentences is cut into. */
export function partCount(tokens: number, sentences: number, caps: PartCaps): number {
  const wanted = Math.ceil(tokens / Math.max(1, caps.part_tokens));
  const n = Math.min(caps.max_bullets_per_chunk, Math.max(caps.min_bullets_per_chunk, wanted));
  return Math.max(1, Math.min(n, sentences));
}

/**
 * Split `segments` into exactly `min(n, segments.length)` contiguous, non-empty parts of roughly
 * equal character length (characters stand in for tokens here; the chunk's token budget is
 * already enforced by the chunker). Sentences are never split and never reordered.
 */
export function splitParts(segments: Segment[], n: number): Segment[][] {
  const k = Math.max(1, Math.min(n, segments.length));
  const total = segments.reduce((a, s) => a + s.text.length, 0);
  const parts: Segment[][] = [];
  let cur: Segment[] = [];
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    cur.push(segments[i]);
    acc += segments[i].text.length;
    const left = segments.length - i - 1;
    const need = k - parts.length - 1; // parts still to open after this one
    if (parts.length < k - 1 && (acc >= (total * (parts.length + 1)) / k || left === need)) {
      parts.push(cur);
      cur = [];
    }
  }
  if (cur.length) parts.push(cur);
  return parts;
}
