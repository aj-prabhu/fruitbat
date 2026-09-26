// Grounding v3 (docs/PLAN.md S1-03, C6; spec/grounding.md).
//
// A deterministic filter for the worst generation errors: a wrong number, or an invented name.
// It is not a truth guarantee (spec/grounding.md) -- it cannot catch a reversed relation or a
// dropped negation. A bullet passes when every number and every "name candidate" in it can be
// found, after normalization, in its own chunk's source text.

import { COMMON_WORDS } from "./commonWords";

export interface GroundResult {
  ok: boolean;
  reasons: string[];
}

export interface GroundChunkResult {
  kept: string[];
  cut: string[];
  allCut: boolean;
}

// ---------------------------------------------------------------------------------------------
// Number normalization (spec/grounding.md "Number normalization (both sides, in this order)")
// ---------------------------------------------------------------------------------------------

const ONES: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90,
  hundredth: 100,
};

/** "five" -> "5", "twenty-one"/"twenty one" -> "21", "a hundred"/"one hundred" -> "100", ordinal words -> digits. */
function replaceSpelledOutNumbers(text: string): string {
  let s = text;
  s = s.replace(/\b(?:a|an|one)\s+hundredth\b/gi, "100"); // one ordinal, not 1 and 100 (Codex merge-gate review, PR #14)
  s = s.replace(/\b(?:a|an|one)\s+hundred\b/gi, "100");

  const tensNames = Object.keys(TENS).join("|");
  const onesCardinalNames = Object.keys(ONES)
    .filter((k) => ONES[k] >= 1 && ONES[k] <= 9)
    .join("|");
  const ordinalOnesNames = Object.keys(ORDINAL_WORDS)
    .filter((k) => ORDINAL_WORDS[k] >= 1 && ORDINAL_WORDS[k] <= 9)
    .join("|");

  // Compounds first (twenty-one, twenty first), so the bare-word passes below don't consume a
  // piece of a compound before the compound regex gets a chance to match it.
  s = s.replace(new RegExp(`\\b(${tensNames})[\\s-](${onesCardinalNames})\\b`, "gi"), (_m, t: string, o: string) =>
    String(TENS[t.toLowerCase()] + ONES[o.toLowerCase()]),
  );
  s = s.replace(new RegExp(`\\b(${tensNames})[\\s-](${ordinalOnesNames})\\b`, "gi"), (_m, t: string, o: string) =>
    String(TENS[t.toLowerCase()] + ORDINAL_WORDS[o.toLowerCase()]),
  );

  const ordinalNames = Object.keys(ORDINAL_WORDS).join("|");
  s = s.replace(new RegExp(`\\b(${ordinalNames})\\b`, "gi"), (m: string) => String(ORDINAL_WORDS[m.toLowerCase()]));
  s = s.replace(new RegExp(`\\b(${tensNames})\\b`, "gi"), (m: string) => String(TENS[m.toLowerCase()]));
  const onesTeensNames = Object.keys(ONES).join("|");
  s = s.replace(new RegExp(`\\b(${onesTeensNames})\\b`, "gi"), (m: string) => String(ONES[m.toLowerCase()]));
  return s;
}

/** One number, per spec/grounding.md: a comma is a thousands separator only when exactly three
 *  digits follow it, and a space never joins two numbers, so "May 3, 2026" is 3 and 2026, "1,400"
 *  is 1400 (Codex merge-gate review, PR #8). Ranges and times split on their own because "-", "–",
 *  "/" and ":" are not part of a number. */
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const NUMBER_RE = new RegExp(NUM, "g");

/**
 * Every number in `text`, normalized (spec/grounding.md): thousands separators and currency
 * stripped, percent stripped, spelled-out numbers <= 100 and ordinals converted, ranges/times
 * split into parts. Case-insensitive throughout.
 */
export function normalizeNumbers(text: string): Set<string> {
  let t = replaceSpelledOutNumbers(text);
  t = t.replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, "$1");
  t = t.replace(new RegExp(String.raw`[$€£]\s?(${NUM})`, "g"), (_m, num: string) => num);
  t = t.replace(new RegExp(String.raw`\b(?:USD|EUR|GBP)\s?(${NUM})`, "gi"), (_m, num: string) => num);
  t = t.replace(new RegExp(String.raw`(${NUM})\s?(?:USD|EUR|GBP)\b`, "gi"), (_m, num: string) => num);
  t = t.replace(new RegExp(String.raw`(${NUM})\s+(?:dollars?|cents?|pounds?|euros?)\b`, "gi"), (_m, num: string) => num);
  t = t.replace(new RegExp(String.raw`(${NUM})\s?%`, "g"), (_m, num: string) => num);
  t = t.replace(new RegExp(String.raw`(${NUM})\s+per\s?cent\b`, "gi"), (_m, num: string) => num);
  t = t.replace(new RegExp(String.raw`(${NUM})\s+percent\b`, "gi"), (_m, num: string) => num);

  const out = new Set<string>();
  for (const raw of t.match(NUMBER_RE) ?? []) out.add(raw.replace(/,/g, ""));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Name candidates (spec/grounding.md "Name candidates")
// ---------------------------------------------------------------------------------------------

const STOPLIST = new Set(
  ["The", "A", "An", "It", "They", "This", "These", "That", "We", "He", "She", "I", "You", "Here", "There", "Then"].map((w) =>
    w.toLowerCase(),
  ),
);

const SENTENCE_END_CHARS = new Set([".", "!", "?", ":", ";", "—"]);
const OPENING_QUOTES = new Set(['"', "'", "“", "‘"]);

function stripSurroundingPunctuation(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

function isAllCapsShort(token: string): boolean {
  return token.length >= 2 && token.length <= 5 && /^\p{Lu}+$/u.test(token);
}

function isNameCandidateToken(stripped: string, sentenceInitial: boolean, commonWords: Set<string>): boolean {
  if (stripped.length === 0) return false;
  if (!/\p{Lu}/u.test(stripped[0])) return false; // any uppercase letter, not only ASCII (Codex review, PR #14)

  // All-caps 2-5 letter tokens (USA, NPS) are candidates unless their lowercase form is a common
  // word (OK, TV are not) -- this exclusion applies regardless of sentence position.
  if (isAllCapsShort(stripped) && commonWords.has(stripped.toLowerCase())) return false;

  if (!sentenceInitial) return true;

  const lower = stripped.toLowerCase();
  if (commonWords.has(lower)) return false;
  if (STOPLIST.has(lower)) return false;
  return true;
}

/** Capitalized tokens in `bullet` that count as name candidates per spec/grounding.md. */
export function nameCandidates(bullet: string, commonWords: Set<string> = COMMON_WORDS): string[] {
  const rawTokens = bullet.split(/\s+/).filter((t) => t.length > 0);
  const out: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const raw = rawTokens[i];
    const stripped = stripSurroundingPunctuation(raw);
    if (!stripped) continue;
    const prev = i > 0 ? rawTokens[i - 1] : null;
    const sentenceInitial =
      i === 0 || (prev !== null && SENTENCE_END_CHARS.has(prev[prev.length - 1])) || OPENING_QUOTES.has(raw[0]);
    if (isNameCandidateToken(stripped, sentenceInitial, commonWords)) out.push(stripped);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Source matching
// ---------------------------------------------------------------------------------------------

/** "Marcus's" -> "marcus"; "White-nose" -> "white-nose" plus its hyphen parts "white", "nose". */
function nameBaseForms(token: string): string[] {
  const noPossessive = token.replace(/['’]s$/i, "");
  const whole = noPossessive.toLowerCase();
  const parts = whole.split("-").filter((p) => p.length > 0);
  return parts.length > 1 ? [whole, ...parts] : [whole];
}

/** Every base form (whole + hyphen parts, possessive stripped, lowercase) of every token in `text`. */
function sourceNameTokenBases(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const stripped = stripSurroundingPunctuation(raw);
    if (!stripped) continue;
    for (const base of nameBaseForms(stripped)) out.add(base);
  }
  return out;
}

function nameFoundInSource(candidate: string, sourceBases: Set<string>): boolean {
  const bases = nameBaseForms(candidate);
  const whole = bases[0];
  if (sourceBases.has(whole)) return true;
  if (bases.length > 1) {
    const parts = bases.slice(1);
    return parts.every((p) => sourceBases.has(p));
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------------------------

/** Does `bullet` pass grounding against `sourceChunkText`? spec/grounding.md "The rule". */
export function ground(bullet: string, sourceChunkText: string, commonWords: Set<string>): GroundResult {
  const reasons: string[] = [];

  const bulletNumbers = normalizeNumbers(bullet);
  const sourceNumbers = normalizeNumbers(sourceChunkText);
  for (const n of bulletNumbers) {
    if (!sourceNumbers.has(n)) reasons.push(`number_not_in_source:${n}`);
  }

  const candidates = nameCandidates(bullet, commonWords);
  const sourceBases = sourceNameTokenBases(sourceChunkText);
  for (const cand of candidates) {
    if (!nameFoundInSource(cand, sourceBases)) reasons.push(`name_not_in_source:${cand}`);
  }

  return { ok: reasons.length === 0, reasons };
}

/** Ground every bullet of a chunk against its own chunk text. spec/grounding.md "all_cut". */
export function groundChunk(bullets: string[], chunkText: string): GroundChunkResult {
  const kept: string[] = [];
  const cut: string[] = [];
  for (const bullet of bullets) {
    const result = ground(bullet, chunkText, COMMON_WORDS);
    if (result.ok) kept.push(bullet);
    else cut.push(bullet);
  }
  return { kept, cut, allCut: bullets.length > 0 && kept.length === 0 };
}
