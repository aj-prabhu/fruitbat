// Sentence segmentation (docs/PLAN.md S1-03, Architecture -> Pipeline: "sentences").
//
// Uses the platform Intl.Segmenter so web and any future Node tooling agree with no vendored
// sentence-boundary logic. Offsets are [start, end) into the ORIGINAL input string that was
// passed in -- callers (chunk.ts, split.ts, the TTS worker) rely on this to map spoken/shown
// text back to the source for highlighting and for the coverage proof (S1-04).
//
// We do not run a separate "normalize the text, then map offsets back" pass: Intl.Segmenter is
// handed the raw input untouched, so every offset it returns is already an offset into that same
// raw string. The only adjustment we make is trimming leading/trailing whitespace off each
// segment (a segment boundary can land mid-whitespace-run), which we do by narrowing the
// [start, end) window rather than by rewriting the string, so offsets never drift from the
// original. A segment that is pure whitespace (or empty) is dropped.
//
// Unpunctuated text (spec/eval/corpus/020.txt, no sentence-ending punctuation) has no boundary
// for Intl.Segmenter to find, so it comes back as one giant Segment spanning the whole input.
// That is intentional and by design (docs/PLAN.md packet S1-03): the TTS-safe splitter
// (split.ts) is what breaks a segment that size into TTS-safe pieces.

export interface Segment {
  text: string;
  start: number;
  end: number;
}

const WHITESPACE = /\s/;

let sentenceSegmenter: Intl.Segmenter | null = null;
function segmenter(): Intl.Segmenter {
  if (!sentenceSegmenter) sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return sentenceSegmenter;
}

/** Split `text` into sentence-ish Segments, offsets into `text` itself. */
export function segmentSentences(text: string): Segment[] {
  const out: Segment[] = [];
  for (const { segment, index } of segmenter().segment(text)) {
    let start = index;
    let end = index + segment.length;
    while (start < end && WHITESPACE.test(text[start])) start++;
    while (end > start && WHITESPACE.test(text[end - 1])) end--;
    if (start === end) continue; // whitespace-only fragment
    out.push({ text: text.slice(start, end), start, end });
  }
  return out;
}
