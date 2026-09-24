// Token-budgeted, sentence-aligned chunking (docs/PLAN.md S1-03, spec/chunking.md "Token budgets").
//
// Packs Segments (from segment.ts) into Chunks that never split a sentence and never exceed
// `budget.chunk_input_tokens`. A sentence that alone overruns the budget is first broken up by
// the same clause/word-boundary rule split.ts uses for TTS safety (spec/chunking.md rule 2: "A
// sentence longer than chunk_input_tokens is first split by the TTS-safe rule above"), just
// measuring tokens instead of phonemes -- see splitByMeasure in split.ts, which this reuses
// directly rather than re-implementing the splitting algorithm.
//
// `countTokens` is injected so unit tests can use a cheap deterministic fake and only the
// dedicated integration test (core.test.ts, doc 011/025) pays for the real pinned tokenizer.

import type { Segment } from "./segment";
import { splitByMeasure, type Measure } from "./split";

export interface Chunk {
  index: number;
  start: number;
  end: number;
  text: string;
  segments: Segment[];
  tokens: number;
}

export interface Budget {
  chunk_input_tokens: number;
  max_chunks: number;
}

export type CountTokens = (text: string) => number | Promise<number>;

export class InputLimitError extends Error {
  readonly chunks: number;
  constructor(chunks: number) {
    super(`input_limit: ${chunks} chunks exceeds max_chunks`);
    this.name = "input_limit";
    this.chunks = chunks;
  }
}

/**
 * Pack `segments` (sentences) into token-budgeted Chunks. Never splits a sentence across chunks;
 * a sentence over `budget.chunk_input_tokens` on its own is pre-split (clause punctuation, then
 * word boundaries, source offsets kept) before packing. Throws `input_limit` if the result would
 * need more than `budget.max_chunks` chunks.
 */
export async function chunkSentences(segments: Segment[], countTokens: CountTokens, budget: Budget): Promise<Chunk[]> {
  const measure: Measure = (text: string) => countTokens(text);

  // Pre-split any sentence that alone overruns the chunk budget.
  const pieces: Segment[] = [];
  for (const seg of segments) {
    const tokens = await measure(seg.text);
    if (tokens <= budget.chunk_input_tokens) {
      pieces.push(seg);
    } else {
      await splitByMeasure(seg, measure, budget.chunk_input_tokens, budget.chunk_input_tokens, pieces);
    }
  }

  // Greedily pack sentence-aligned pieces into chunks up to the token budget. A doc that fits
  // under the budget entirely comes out as exactly one chunk (spec/chunking.md rule 5).
  const chunks: Chunk[] = [];
  let curSegs: Segment[] = [];
  let curTokens = 0;

  const flush = async (): Promise<void> => {
    if (curSegs.length === 0) return;
    const start = curSegs[0].start;
    const end = curSegs[curSegs.length - 1].end;
    const text = curSegs.map((s) => s.text).join(" ");
    const tokens = await measure(text);
    chunks.push({ index: chunks.length, start, end, text, segments: curSegs, tokens });
    curSegs = [];
    curTokens = 0;
  };

  for (const piece of pieces) {
    const t = await measure(piece.text);
    if (curSegs.length > 0 && curTokens + t > budget.chunk_input_tokens) {
      await flush();
    }
    curSegs.push(piece);
    curTokens += t;
  }
  await flush();

  if (chunks.length > budget.max_chunks) {
    throw new InputLimitError(chunks.length);
  }

  return chunks;
}
