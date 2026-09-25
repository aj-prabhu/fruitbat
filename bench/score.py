#!/usr/bin/env python3
"""bench/score.py — the automated diagnostic scorer (docs/PLAN.md S0-05, KPI "Faithfulness,
diagnostic"). Given one generated output (bullets, or the one line) for one corpus doc at one
dial level, prints a JSON object with the token-overlap metrics that gate PRs in bench/gate.py:

    facts_token_hit      share of key_facts whose distinctive tokens appear in the output
    halluc_flags         count of numbers in the output absent from the source (both sides
                          normalized the way spec/grounding.md normalizes numbers)
    forbidden_hits       count of forbidden_claims whose distinctive_tokens all appear,
                          as whole lowercase words, in the output
    oneline_keyword_hit  share of expected_oneline_keywords present (oneline level only)
    coverage             passthrough of --coverage (readall level only; the real coverage
                          number — offset tiling + duration additivity — is computed by the
                          TS/Swift harness, not here)

This is a deterministic proxy, not the grounding filter and not the graded rubric (spec/eval/
grade.md): it cannot see a reversed relation or a dropped negation. It exists so bench/gate.py
has a number to gate PRs on without a human or an LLM in the loop.

Usage:
    python3 bench/score.py --doc 011 --level short --output /path/to/bullets.txt
    python3 bench/score.py --doc 020 --level readall --output /path/to/transcript.txt --coverage 0.98

Stdlib only.
"""
import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
DEFAULT_CORPUS_DIR = HERE.parent / "spec" / "eval" / "corpus"
LEVELS = ["readall", "short", "caveman", "oneline"]

# A short built-in stopword list for deriving "distinctive tokens" out of a key_fact
# sentence (key_facts don't carry a precomputed distinctive_tokens list the way
# forbidden_claims do). Deliberately small: it only needs to filter out glue words,
# not do real NLP.
STOPWORDS = {
    "the", "a", "an", "of", "to", "in", "on", "and", "or", "is", "was", "were", "be",
    "been", "being", "that", "this", "these", "those", "it", "its", "at", "by", "for",
    "with", "as", "from", "has", "have", "had", "which", "who", "whom", "not", "no",
    "but", "than", "then", "so", "their", "they", "he", "she", "we", "you", "i", "are",
    "will", "would", "can", "could", "should", "may", "might", "about", "into", "over",
    "under", "more", "most", "less", "least", "each", "every", "other", "such", "only",
    "just", "also", "when", "where", "while", "because", "if", "do", "does", "did",
    "there", "here", "them", "his", "her", "him", "our", "your", "some", "all", "any",
    "per", "up", "out", "off", "one", "two",
    "already", "estimated", "typically", "significant", "approximately", "various",
    "certain", "several", "many", "much", "really", "quite", "especially",
    "particularly", "essentially", "basically", "generally", "usually", "currently",
    "recently", "expected", "including", "provide", "provides", "face", "faces",
}

# --- spelled-out number / ordinal conversion (spec/eval/../grounding.md's rule, ported
# to Python for this diagnostic scorer). Only exact words listed are recognized. ---
ONES_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
    "eighteen": 18, "nineteen": 19,
}
TENS_WORDS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
    "eighty": 80, "ninety": 90,
}
ORDINAL_ONES = {
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6,
    "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10, "eleventh": 11, "twelfth": 12,
    "thirteenth": 13, "fourteenth": 14, "fifteenth": 15, "sixteenth": 16,
    "seventeenth": 17, "eighteenth": 18, "nineteenth": 19,
}
ORDINAL_TENS = {
    "twentieth": 20, "thirtieth": 30, "fortieth": 40, "fiftieth": 50, "sixtieth": 60,
    "seventieth": 70, "eightieth": 80, "ninetieth": 90,
}


def _replace_spelled_numbers(text):
    """Replace spelled-out cardinals/ordinals (<=100) with digits, best-effort."""
    tens_pat = "|".join(TENS_WORDS)
    ones_pat = "|".join(ONES_WORDS)
    ord_ones_pat = "|".join(ORDINAL_ONES)
    ord_tens_pat = "|".join(ORDINAL_TENS)

    text = re.sub(r"\b(a|one)\s+hundred\b", "100", text)
    text = re.sub(r"\bhundredth\b", "100", text)
    # compounds first, so "twenty-one" doesn't degrade into separate "20" + "1"
    text = re.sub(
        rf"\b({tens_pat})[\s-]({ones_pat})\b",
        lambda m: str(TENS_WORDS[m.group(1)] + ONES_WORDS[m.group(2)]),
        text,
    )
    text = re.sub(
        rf"\b({tens_pat})[\s-]({ord_ones_pat})\b",
        lambda m: str(TENS_WORDS[m.group(1)] + ORDINAL_ONES[m.group(2)]),
        text,
    )
    text = re.sub(rf"\b({ord_tens_pat})\b", lambda m: str(ORDINAL_TENS[m.group(1)]), text)
    text = re.sub(rf"\b({tens_pat})\b", lambda m: str(TENS_WORDS[m.group(1)]), text)
    text = re.sub(rf"\b({ord_ones_pat})\b", lambda m: str(ORDINAL_ONES[m.group(1)]), text)
    text = re.sub(rf"\b({ones_pat})\b", lambda m: str(ONES_WORDS[m.group(1)]), text)
    return text


def extract_numbers(text):
    """Every number in `text`, normalized per spec/grounding.md: spelled-out numbers and
    word ordinals converted to digits, numeric ordinal suffixes stripped, thousands
    separators (comma, space, or a single ambiguous dot-group of exactly 3 digits)
    collapsed. Returns a list (with duplicates) in reading order — halluc_flags counts
    occurrences, not distinct values.
    """
    t = text.lower()
    t = _replace_spelled_numbers(t)
    t = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", t)
    t = re.sub(r"\b\d{1,3}(?:,\d{3})+\b", lambda m: m.group(0).replace(",", ""), t)
    t = re.sub(r"\b\d{1,3}(?: \d{3})+\b", lambda m: m.group(0).replace(" ", ""), t)
    t = re.sub(r"\b\d{1,3}\.\d{3}\b(?!\d)", lambda m: m.group(0).replace(".", ""), t)
    return re.findall(r"\d+(?:\.\d+)?", t)


def _whole_word(haystack_lower, word):
    return re.search(rf"\b{re.escape(word)}\b", haystack_lower) is not None


def compute_halluc_flags(source_text, output_text):
    source_numbers = set(extract_numbers(source_text))
    output_numbers = extract_numbers(output_text)
    return sum(1 for n in output_numbers if n not in source_numbers)


def compute_forbidden_hits(output_text, forbidden_claims):
    out_lower = output_text.lower()
    hits = 0
    for claim in forbidden_claims:
        tokens = claim.get("distinctive_tokens") or []
        if tokens and all(_whole_word(out_lower, tok) for tok in tokens):
            hits += 1
    return hits


def _number_distinctiveness(num_str):
    """A short, common integer ("1", "2", "3") is barely distinctive on its own and
    crowds out real words when a fact happens to contain several of them (e.g. "1/2
    ounce (13 g)... three nickel coins"). A decimal or a number >= 10 is specific
    enough to be worth matching on; anything smaller only wins if nothing else is
    available."""
    if "." in num_str:
        return 1000
    try:
        value = int(num_str)
    except ValueError:
        return 0
    return 900 if value >= 10 else 5


def _fact_distinctive_tokens(fact_text, max_tokens=3):
    """Rank every number and non-stopword word in the fact by distinctiveness and take
    the top `max_tokens`, mirroring the 2-4 distinctive_tokens convention
    forbidden_claims already use (spec/eval/validate.py) but derived automatically
    since key_facts don't carry a precomputed list. A capitalized word (an acronym or
    a proper noun — the same intuition as spec/grounding.md's name candidates) outranks
    a merely-long common word, since it's what a paraphrase is least likely to drop."""
    candidates = []  # (score, token)

    seen_numbers = set()
    for n in extract_numbers(fact_text):
        if n in seen_numbers:
            continue
        seen_numbers.add(n)
        candidates.append((_number_distinctiveness(n), n))

    seen_words = set()
    for w in re.findall(r"[A-Za-z']+", fact_text):
        lw = w.lower().strip("'")
        if len(lw) < 2 or lw in STOPWORDS or lw in seen_words:
            continue
        seen_words.add(lw)
        score_val = len(lw) * 10
        if w.isupper() and len(w) <= 6:
            score_val += 300  # acronym, e.g. WNS
        elif w[:1].isupper():
            score_val += 150  # proper noun, e.g. Brazilian, Carlsbad
        candidates.append((score_val, lw))

    candidates.sort(key=lambda c: -c[0])
    return [tok for _, tok in candidates[:max_tokens]]


def _is_number_token(tok):
    return re.fullmatch(r"\d+(?:\.\d+)?", tok) is not None


def compute_facts_token_hit(key_facts, output_text):
    if not key_facts:
        return 1.0
    output_numbers = set(extract_numbers(output_text))
    out_lower = output_text.lower()
    hits = 0
    for fact in key_facts:
        tokens = _fact_distinctive_tokens(fact)
        if not tokens:
            hits += 1  # nothing distinctive to check; don't penalize a degenerate fact
            continue
        ok = all(
            (tok in output_numbers) if _is_number_token(tok) else _whole_word(out_lower, tok)
            for tok in tokens
        )
        if ok:
            hits += 1
    return hits / len(key_facts)


def compute_oneline_keyword_hit(output_text, keywords):
    if not keywords:
        return None
    out_lower = output_text.lower()
    hits = sum(1 for kw in keywords if kw.lower() in out_lower)
    return hits / len(keywords)


def score(doc_id, level, output_text, source_text, facts, coverage=None):
    result = {
        "doc": doc_id,
        "level": level,
        "facts_token_hit": None,
        "halluc_flags": None,
        "forbidden_hits": None,
        "oneline_keyword_hit": None,
        "coverage": None,
    }
    if level == "readall":
        result["coverage"] = coverage
        return result

    result["facts_token_hit"] = round(compute_facts_token_hit(facts.get("key_facts", []), output_text), 4)
    result["halluc_flags"] = compute_halluc_flags(source_text, output_text)
    result["forbidden_hits"] = compute_forbidden_hits(output_text, facts.get("forbidden_claims", []))
    if level == "oneline":
        klist = facts.get("expected_oneline_keywords", [])
        hit = compute_oneline_keyword_hit(output_text, klist)
        result["oneline_keyword_hit"] = round(hit, 4) if hit is not None else None
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--doc", required=True, help="corpus doc id, e.g. 011")
    ap.add_argument("--level", required=True, choices=LEVELS)
    ap.add_argument("--output", required=True, help="path to the generated bullets / one line")
    ap.add_argument("--coverage", type=float, default=None, help="readall only: passthrough coverage number")
    ap.add_argument("--corpus-dir", default=str(DEFAULT_CORPUS_DIR))
    args = ap.parse_args()

    corpus_dir = Path(args.corpus_dir)
    source_path = corpus_dir / f"{args.doc}.txt"
    facts_path = corpus_dir / f"{args.doc}.facts.json"
    output_path = Path(args.output)

    for p, label in ((source_path, "source"), (facts_path, "facts"), (output_path, "output")):
        if not p.exists() or p.stat().st_size == 0:
            print(f"error: missing or empty {label} file: {p}", file=sys.stderr)
            sys.exit(2)

    source_text = source_path.read_text(encoding="utf-8")
    facts = json.loads(facts_path.read_text(encoding="utf-8"))
    output_text = output_path.read_text(encoding="utf-8")

    result = score(args.doc, args.level, output_text, source_text, facts, coverage=args.coverage)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
