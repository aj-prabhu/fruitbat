// Table-driven proof for packet S1-03 (docs/PLAN.md): every case in spec/fixtures/{segment,
// split,chunk,bullets,ground}.json runs through the real TypeScript implementation here, plus a
// few integration tests that use the real pinned tokenizer (S1-03a) and the real vendored
// phonemizer instead of a fixture-described fake.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import segmentFixtures from "../../../spec/fixtures/segment.json";
import splitFixtures from "../../../spec/fixtures/split.json";
import chunkFixtures from "../../../spec/fixtures/chunk.json";
import bulletsFixtures from "../../../spec/fixtures/bullets.json";
import groundFixtures from "../../../spec/fixtures/ground.json";

import { segmentSentences } from "../core/segment";
import { splitTtsSafe, type Phonemize } from "../core/split";
import { chunkSentences, InputLimitError, type CountTokens } from "../core/chunk";
import { BulletParser } from "../core/bullets";
import { ground, groundChunk, nameCandidates } from "../core/ground";
import { COMMON_WORDS } from "../core/commonWords";
import { countTokensWith, tokenizerReady } from "../core/tokens";
// eslint-disable-next-line import/no-unresolved -- vendored JS, no types
import { phonemize as realPhonemize } from "../vendor/kokoro/phonemize.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../"); // web/src/tests -> repo root

function readCorpus(id: string): string {
  return readFileSync(path.join(repoRoot, "spec/eval/corpus", `${id}.txt`), "utf8");
}

// ------------------------------------------------------------------------------------------
// segment.ts
// ------------------------------------------------------------------------------------------

describe("segment.ts fixtures (spec/fixtures/segment.json)", () => {
  for (const c of segmentFixtures as Array<{ name: string; input: string; expect: unknown; why: string }>) {
    it(c.name, () => {
      expect(segmentSentences(c.input)).toEqual(c.expect);
    });
  }
});

// ------------------------------------------------------------------------------------------
// split.ts
// ------------------------------------------------------------------------------------------

interface PhonemizeDescriptor {
  kind: "charcount";
}

function makeFakePhonemize(descriptor: PhonemizeDescriptor): Phonemize {
  if (descriptor.kind === "charcount") {
    return async (text: string) => "x".repeat(text.length);
  }
  throw new Error(`unknown phonemize descriptor: ${JSON.stringify(descriptor)}`);
}

describe("split.ts fixtures (spec/fixtures/split.json)", () => {
  for (const c of splitFixtures as Array<{
    name: string;
    input: { text: string; phonemize: PhonemizeDescriptor; target: number; limit: number };
    expect: unknown;
    why: string;
  }>) {
    it(c.name, async () => {
      const { text, phonemize, target, limit } = c.input;
      const segments = [{ text, start: 0, end: text.length }];
      const out = await splitTtsSafe(segments, makeFakePhonemize(phonemize), { target, limit });
      expect(out).toEqual(c.expect);
    });
  }
});

// ------------------------------------------------------------------------------------------
// chunk.ts
// ------------------------------------------------------------------------------------------

interface CountTokensDescriptor {
  kind: "wordcount";
  factor: number;
}

function makeFakeCountTokens(descriptor: CountTokensDescriptor): CountTokens {
  if (descriptor.kind === "wordcount") {
    return (text: string) => {
      const trimmed = text.trim();
      const words = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
      return Math.ceil(words.length * descriptor.factor);
    };
  }
  throw new Error(`unknown countTokens descriptor: ${JSON.stringify(descriptor)}`);
}

describe("chunk.ts fixtures (spec/fixtures/chunk.json)", () => {
  for (const c of chunkFixtures as Array<{
    name: string;
    input: { text: string; countTokens: CountTokensDescriptor; chunk_input_tokens: number; max_chunks: number };
    expect: { chunks: Array<{ index: number; start: number; end: number; text: string; tokens: number; segmentCount: number }> } | { error: string; chunks: number };
    why: string;
  }>) {
    it(c.name, async () => {
      const { text, countTokens, chunk_input_tokens, max_chunks } = c.input;
      const segments = segmentSentences(text);
      const budget = { chunk_input_tokens, max_chunks };
      if ("error" in c.expect) {
        let caught: InputLimitError | null = null;
        try {
          await chunkSentences(segments, makeFakeCountTokens(countTokens), budget);
        } catch (e) {
          caught = e as InputLimitError;
        }
        expect(caught).not.toBeNull();
        expect(caught?.name).toBe(c.expect.error);
        expect(caught?.chunks).toBe(c.expect.chunks);
      } else {
        const chunks = await chunkSentences(segments, makeFakeCountTokens(countTokens), budget);
        const simplified = chunks.map((chunk) => ({
          index: chunk.index,
          start: chunk.start,
          end: chunk.end,
          text: chunk.text,
          tokens: chunk.tokens,
          segmentCount: chunk.segments.length,
        }));
        expect(simplified).toEqual(c.expect.chunks);
      }
    });
  }
});

// ------------------------------------------------------------------------------------------
// bullets.ts
// ------------------------------------------------------------------------------------------

describe("bullets.ts fixtures (spec/fixtures/bullets.json)", () => {
  for (const c of bulletsFixtures as Array<{
    name: string;
    input: { max_bullets_per_chunk: number; max_words_per_bullet: number; pushes: string[]; flush: boolean };
    expect: { pushResults: unknown[]; flushResult?: unknown; dropped: number; overlength: number };
    why: string;
  }>) {
    it(c.name, () => {
      const parser = new BulletParser({
        max_bullets_per_chunk: c.input.max_bullets_per_chunk,
        max_words_per_bullet: c.input.max_words_per_bullet,
      });
      const pushResults = c.input.pushes.map((text) => parser.push(text));
      expect(pushResults).toEqual(c.expect.pushResults);
      if (c.input.flush) {
        expect(parser.flush()).toEqual(c.expect.flushResult);
      }
      expect(parser.dropped).toBe(c.expect.dropped);
      expect(parser.overlength).toBe(c.expect.overlength);
    });
  }
});

// ------------------------------------------------------------------------------------------
// ground.ts
// ------------------------------------------------------------------------------------------

describe("ground.ts fixtures (spec/fixtures/ground.json)", () => {
  for (const c of groundFixtures as Array<{ name: string; kind: string; input: Record<string, unknown>; expect: unknown; why: string }>) {
    it(c.name, () => {
      switch (c.kind) {
        case "ground": {
          const { bullet, source } = c.input as { bullet: string; source: string };
          expect(ground(bullet, source, COMMON_WORDS)).toEqual(c.expect);
          break;
        }
        case "groundChunk": {
          const { bullets, chunkText } = c.input as { bullets: string[]; chunkText: string };
          expect(groundChunk(bullets, chunkText)).toEqual(c.expect);
          break;
        }
        case "nameCandidates": {
          const { bullet } = c.input as { bullet: string };
          expect({ candidates: nameCandidates(bullet) }).toEqual(c.expect);
          break;
        }
        default:
          throw new Error(`unknown ground fixture kind: ${c.kind}`);
      }
    });
  }
});

// ------------------------------------------------------------------------------------------
// Fixture shape (every file: >= 8 cases, each with name/input/expect/why)
// ------------------------------------------------------------------------------------------

describe("fixture file shape", () => {
  const files: Record<string, unknown[]> = {
    "segment.json": segmentFixtures,
    "split.json": splitFixtures,
    "chunk.json": chunkFixtures,
    "bullets.json": bulletsFixtures,
    "ground.json": groundFixtures,
  };

  for (const [name, cases] of Object.entries(files)) {
    it(`${name} has >= 8 cases with name/input/expect/why`, () => {
      expect(cases.length).toBeGreaterThanOrEqual(8);
      for (const c of cases as Array<Record<string, unknown>>) {
        expect(typeof c.name).toBe("string");
        expect("input" in c).toBe(true);
        expect("expect" in c).toBe(true);
        expect(typeof c.why).toBe("string");
      }
    });
  }
});

// ------------------------------------------------------------------------------------------
// Integration: real pinned tokenizer (S1-03a) on docs 011 and 025.
// ------------------------------------------------------------------------------------------

describe("chunk.ts with the real pinned tokenizer", () => {
  it(
    "doc 011 (spec/eval/manifest.json role sample-article) chunks under the production budget",
    async () => {
      const tok = await tokenizerReady();
      const segments = segmentSentences(readCorpus("011"));
      const chunks = await chunkSentences(segments, (text) => countTokensWith(tok, text), { chunk_input_tokens: 1600, max_chunks: 100 });
      // eslint-disable-next-line no-console
      console.log(`PROOF doc011_chunks=${chunks.length}`);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    },
    120_000,
  );

  it(
    "doc 025 (spec/eval/manifest.json role multi-chunk) needs more than one chunk",
    async () => {
      const tok = await tokenizerReady();
      const segments = segmentSentences(readCorpus("025"));
      const chunks = await chunkSentences(segments, (text) => countTokensWith(tok, text), { chunk_input_tokens: 1600, max_chunks: 100 });
      // eslint-disable-next-line no-console
      console.log(`PROOF doc025_chunks=${chunks.length}`);
      expect(chunks.length).toBeGreaterThan(1);
    },
    120_000,
  );
});

// ------------------------------------------------------------------------------------------
// Integration: real vendored phonemizer (docs/PLAN.md S1-00a) on doc 020 (unpunctuated).
// ------------------------------------------------------------------------------------------

describe("split.ts with the real vendored phonemizer", () => {
  it(
    "doc 020 (unpunctuated) splits into TTS-safe pieces that tile the source",
    async () => {
      const text = readCorpus("020");
      const segments = segmentSentences(text);
      // spec/eval/corpus/020.txt has zero in-paragraph terminal punctuation ('.', '!', '?', ':',
      // ';' all appear 0 times), but Intl.Segmenter still breaks on the blank lines between
      // paragraphs (dialogue turns), so this is 27 paragraph-sized "sentences", not one giant
      // one -- unlike the single-paragraph synthetic case in spec/fixtures/segment.json.
      expect(segments.length).toBe(27);

      let totalOut = 0;
      let maxPhonemes = 0;
      for (const segment of segments) {
        const out = await splitTtsSafe([segment], realPhonemize as Phonemize, { target: 300, limit: 510 });
        // Tiling holds WITHIN each paragraph segment: contiguous, spanning exactly that segment.
        expect(out[0].start).toBe(segment.start);
        expect(out[out.length - 1].end).toBe(segment.end);
        for (let i = 0; i < out.length - 1; i++) {
          expect(out[i].end).toBe(out[i + 1].start);
        }
        for (const piece of out) {
          const phonemes = await realPhonemize(piece.text);
          maxPhonemes = Math.max(maxPhonemes, phonemes.length);
          expect(phonemes.length).toBeLessThanOrEqual(510);
        }
        totalOut += out.length;
      }
      // eslint-disable-next-line no-console
      console.log(`PROOF doc020_segments=${totalOut} doc020_max_phonemes=${maxPhonemes}`);
    },
    120_000,
  );
});
