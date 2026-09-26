// The embedded common-word list for grounding v3 (spec/grounding.md "Name candidates").
// spec/common-words.txt: the 5,000 most frequent English words, lowercase, one per line
// (Peter Norvig, count_1w.txt, Google Web Trillion Word Corpus, fetched 2026-09-23). Both web and
// Mac embed the file as-is at build time; looked up lowercase.
import raw from "../../../spec/common-words.txt?raw";

export const COMMON_WORDS: Set<string> = new Set(
  raw
    .split(/\r?\n/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0),
);
