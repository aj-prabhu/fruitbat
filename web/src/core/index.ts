// Re-exports for spec/PLAN.md packet S1-03: segmenter, TTS-safe splitter, chunker, bullet
// parser, grounding v3. Downstream (S1-04 TTS worker, S1-05 LLM worker, S1-06 orchestrator)
// imports from here rather than reaching into individual core/*.ts files.

export type { Segment } from "./segment";
export { segmentSentences } from "./segment";

export type { Limits, Phonemize, Measure } from "./split";
export { splitTtsSafe, splitByMeasure, assertFits, TtsOverlimitError } from "./split";

export type { Chunk, Budget, CountTokens } from "./chunk";
export { chunkSentences, InputLimitError } from "./chunk";

export type { Bullet, BulletParserOptions } from "./bullets";
export { BulletParser } from "./bullets";

export type { GroundResult, GroundChunkResult } from "./ground";
export { normalizeNumbers, nameCandidates, ground, groundChunk } from "./ground";

export { COMMON_WORDS } from "./commonWords";

// Also re-export the already-built tokenizer module (S1-03a) so callers of this packet's
// index don't need a second import path for token counting.
export { countTokens, countTokensWith, tokenizerReady } from "./tokens";
