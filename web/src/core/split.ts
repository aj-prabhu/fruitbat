// TTS-safe splitting (docs/PLAN.md S1-03, spec/chunking.md "TTS-safe segments").
//
// Breaks a Segment whose phoneme count would overrun the voice model into smaller Segments that
// each fit, while keeping [start, end) offsets that TILE the parent: no gaps, no overlaps, first
// piece starts where the parent starts, last piece ends where the parent ends. That tiling is
// what the coverage proof (S1-04) checks on doc 020, and it is what lets the TTS worker map
// played audio back to source offsets for highlighting.
//
// The splitting rule (spec/chunking.md): split at clause punctuation first (comma, semicolon,
// colon, dash), then at word boundaries, greedily packing words up to `target` phonemes. A
// single "word" (no internal whitespace) that still overruns the hard `limit` on its own is cut
// at a fixed character width, recursively, until every piece fits -- spec/chunking.md calls this
// "should be impossible" in practice and it is only a backstop.
//
// The phonemizer is injected (`Phonemize`) so production passes the vendored eSpeak-based
// phonemizer (web/src/vendor/kokoro/phonemize.js) and tests pass a fake that maps characters to
// phonemes 1:1, or a lookup table -- spec/chunking.md's measured limit (510 phonemes) is a count
// of *phonemes*, one phoneme character = one token.
//
// chunk.ts reuses the same clause/word-boundary algorithm (via `splitByMeasure`) to break a
// single sentence that overruns the token budget, just swapping the phoneme-counting `measure`
// for a token-counting one -- the "TTS-safe rule" in spec/chunking.md's chunking section is this
// same algorithm, not a second implementation.

import type { Segment } from "./segment";

export interface Limits {
  target: number;
  limit: number;
}

/** phonemize(text) -> the phonemized string; phoneme count = the returned string's length. */
export type Phonemize = (text: string) => Promise<string>;

/** A generic "how big is this text" probe: phoneme count, token count, whatever the caller needs. */
export type Measure = (text: string) => number | Promise<number>;

export class TtsOverlimitError extends Error {
  readonly phonemes: number;
  readonly limit: number;
  constructor(phonemes: number, limit: number) {
    super(`tts_overlimit: ${phonemes} phonemes exceeds limit ${limit}`);
    this.name = "tts_overlimit";
    this.phonemes = phonemes;
    this.limit = limit;
  }
}

/** Throws tts_overlimit if `phonemes` exceeds `limit`. Exported for the TTS worker's per-call assertion. */
export function assertFits(phonemes: number, limit: number): void {
  if (phonemes > limit) throw new TtsOverlimitError(phonemes, limit);
}

/**
 * Split every segment whose measured size exceeds `limits.target`, at clause punctuation first,
 * then at word boundaries, so every output is <= `limits.limit`. Never returns an output over the
 * limit; throws `tts_overlimit` in the (should-be-impossible) case a fixed-width cut still can't
 * bring a single character below the limit.
 */
export async function splitTtsSafe(segments: Segment[], phonemize: Phonemize, limits: Limits): Promise<Segment[]> {
  const measure: Measure = async (text: string) => (await phonemize(text)).length;
  const out: Segment[] = [];
  for (const seg of segments) {
    await splitByMeasure(seg, measure, limits.target, limits.limit, out);
  }
  return out;
}

/**
 * The shared clause-then-word splitting algorithm, generic over what "too big" means. Used by
 * splitTtsSafe (measure = phoneme count) and by chunk.ts (measure = token count) so there is one
 * splitting rule, not two. Pushes tiling Segments into `out`.
 */
export async function splitByMeasure(seg: Segment, measure: Measure, target: number, limit: number, out: Segment[]): Promise<void> {
  const count = await measure(seg.text);
  if (count <= target) {
    out.push(seg);
    return;
  }
  const clauseParts = splitAtClausePunctuation(seg);
  if (clauseParts.length > 1) {
    // Pack adjacent clauses back up to `target` so a comma-heavy sentence does not shatter into
    // three-word pieces (S1-04: prosody and the additivity proof both need pieces near the
    // target). A clause that alone exceeds `target` falls through to the word-boundary split.
    let cur: Segment | null = null;
    const flush = async (): Promise<void> => {
      if (cur) await splitByMeasure(cur, measure, target, limit, out);
      cur = null;
    };
    for (const part of clauseParts) {
      if (!cur) {
        cur = part;
        continue;
      }
      const merged: Segment = { text: seg.text.slice(cur.start - seg.start, part.end - seg.start), start: cur.start, end: part.end };
      if ((await measure(merged.text)) <= target) {
        cur = merged;
      } else {
        await flush();
        cur = part;
      }
    }
    await flush();
    return;
  }
  await splitByWordBoundary(seg, measure, target, limit, out);
}

// Clause punctuation per spec/chunking.md: comma, semicolon, colon, em/en dash anywhere, and a
// bare hyphen only when it stands alone between whitespace (a spaced dash used as punctuation,
// e.g. "wrap up - then go"), so a compound word like "well-known" is not shredded mid-word.
// A comma or colon glued to digits (1,400 or 12:30) is not a clause boundary: require whitespace
// after the mark (Codex review, PR #14).
const CLAUSE_PUNCTUATION = /[,;:](?=\s)|[—–]|(?<=\s)-(?=\s)/g;

/** Split `seg` right after every clause-punctuation match. Contiguous: parts tile `seg` exactly. */
function splitAtClausePunctuation(seg: Segment): Segment[] {
  const parts: Segment[] = [];
  let last = 0;
  CLAUSE_PUNCTUATION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAUSE_PUNCTUATION.exec(seg.text))) {
    const cut = m.index + m[0].length;
    if (cut > last) {
      parts.push({ text: seg.text.slice(last, cut), start: seg.start + last, end: seg.start + cut });
      last = cut;
    }
  }
  if (last < seg.text.length || parts.length === 0) {
    parts.push({ text: seg.text.slice(last), start: seg.start + last, end: seg.end });
  }
  return parts;
}

interface Word {
  start: number;
  end: number;
}

function tokenizeWords(text: string, offset: number): Word[] {
  const words: Word[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    words.push({ start: offset + m.index, end: offset + m.index + m[0].length });
  }
  return words;
}

/**
 * Greedily group words up to `target`, assigning any inter-word gap to the end of the earlier
 * group so the outputs tile `seg` with no gaps. A single word that alone exceeds `limit` falls
 * through to the fixed-width cut.
 */
async function splitByWordBoundary(seg: Segment, measure: Measure, target: number, limit: number, out: Segment[]): Promise<void> {
  const words = tokenizeWords(seg.text, seg.start);
  if (words.length <= 1) {
    const count = await measure(seg.text);
    if (count > limit) await splitFixedWidth(seg, measure, limit, out);
    else out.push(seg);
    return;
  }

  // groupEndsAt[i] = the word-index a group ends on, in order. groupEnd always trails k by
  // exactly one word right before a failed candidate test, so the reset below always lands
  // groupStart/groupEnd on k (never skips a word and never re-tests one).
  const groupEndsAt: number[] = [];
  let groupStart = 0;
  let groupEnd = 0;
  for (let k = 1; k < words.length; k++) {
    const candidateText = seg.text.slice(words[groupStart].start - seg.start, words[k].end - seg.start);
    const count = await measure(candidateText);
    if (count <= target) {
      groupEnd = k;
    } else {
      groupEndsAt.push(groupEnd);
      groupStart = groupEnd + 1;
      groupEnd = groupStart;
    }
  }
  groupEndsAt.push(groupEnd);

  let cursor = seg.start;
  for (let i = 0; i < groupEndsAt.length; i++) {
    const endWordIdx = groupEndsAt[i];
    const isLast = i === groupEndsAt.length - 1;
    const charEnd = isLast ? seg.end : words[endWordIdx + 1].start;
    const groupSeg: Segment = { text: seg.text.slice(cursor - seg.start, charEnd - seg.start), start: cursor, end: charEnd };
    const count = await measure(groupSeg.text);
    if (count > limit) {
      await splitFixedWidth(groupSeg, measure, limit, out);
    } else {
      out.push(groupSeg);
    }
    cursor = charEnd;
  }
}

/** Cut `seg.text` in half, recursively, until every piece is <= limit. Contiguous by construction. */
async function splitFixedWidth(seg: Segment, measure: Measure, limit: number, out: Segment[]): Promise<void> {
  const count = await measure(seg.text);
  if (count <= limit) {
    out.push(seg);
    return;
  }
  if (seg.text.length <= 1) {
    // A single character whose phoneme/token count alone exceeds the limit: spec/chunking.md
    // calls the whole scenario "should be impossible"; this is the genuine dead end.
    throw new TtsOverlimitError(count, limit);
  }
  const mid = Math.floor(seg.text.length / 2);
  const left: Segment = { text: seg.text.slice(0, mid), start: seg.start, end: seg.start + mid };
  const right: Segment = { text: seg.text.slice(mid), start: seg.start + mid, end: seg.end };
  await splitFixedWidth(left, measure, limit, out);
  await splitFixedWidth(right, measure, limit, out);
}
