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
 * A sentence that opens with one of these words leans on the sentence before it ("They are often
 * called fruit bats", "Instead they rely on large eyes"). Cut off from its referent, the model
 * guesses one: megabat Caveman said "Flying foxes have large eyes" when the part began "Instead
 * they rely on large eyes" and the next sentence named flying foxes. So a part does not start on
 * such a sentence unless there is no other way to fill every part.
 */
const LEANS_BACK = new Set(["they", "their", "them", "it", "its", "this", "these", "those", "he", "she", "his", "her", "him", "instead", "also", "however", "but", "and", "so", "such"]);

function leansBack(seg: Segment | undefined): boolean {
  if (!seg) return false;
  const first = /\p{L}+/u.exec(seg.text)?.[0]?.toLowerCase();
  return first !== undefined && LEANS_BACK.has(first);
}

/**
 * Split `segments` into exactly `min(n, segments.length)` contiguous, non-empty parts of roughly
 * equal character length (characters stand in for tokens here; the chunk's token budget is
 * already enforced by the chunker). Sentences are never split and never reordered, and a part
 * starts on a sentence that leans back (see LEANS_BACK) only when it must.
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
    const due = acc >= (total * (parts.length + 1)) / k && !leansBack(segments[i + 1]);
    if (parts.length < k - 1 && (due || left === need)) {
      parts.push(cur);
      cur = [];
    }
  }
  if (cur.length) parts.push(cur);
  return parts;
}
