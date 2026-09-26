#!/usr/bin/env python3
"""Validator for spec/eval/manifest.json + spec/eval/corpus/.

Usage:
    python3 spec/eval/validate.py --corpus-only   # S0-04a proof
    python3 spec/eval/validate.py                 # also checks S0-04b facts files

On success, --corpus-only prints exactly "30 docs OK, roles OK" and exits 0.
On failure, prints every problem found, one per line, and exits 1.
Stdlib only.
"""
import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
MANIFEST_PATH = HERE / "manifest.json"
CORPUS_DIR = HERE / "corpus"
ATTRIBUTION_PATH = CORPUS_DIR / "ATTRIBUTION.md"

CATEGORY_RANGES = {
    "short": (1, 10, (300, 600)),
    "medium": (11, 20, (1000, 2000)),
    "long": (21, 30, (5000, 12000)),
}
ROLE_BY_ID = {"005": "relational-negation", "011": "sample-article",
              "020": "unpunctuated", "025": "multi-chunk"}
GRADED_SET = ["005", "011", "013", "020", "025", "028"]
GENRE_MINIMUMS = {"news": 4, "howto": 4, "science": 4, "fiction": 4, "legal": 3, "email": 3}
PDF_IDS = {"011", "013", "025"}
MAX_ORIGINAL_CC0 = 5
MAX_DUPLICATE_PARAGRAPHS = 2



def claim_words(claim):
    """Lowercase letter/digit words of a claim, with separators inside numbers removed."""
    import re as _re
    text = _re.sub(r"(?<=\d)[,.](?=\d)", "", str(claim).lower())
    return set(_re.findall(r"[a-z0-9]+", text))

def load_manifest(problems):
    if not MANIFEST_PATH.exists():
        problems.append(f"missing {MANIFEST_PATH}")
        return None
    try:
        return json.loads(MANIFEST_PATH.read_text())
    except json.JSONDecodeError as e:
        problems.append(f"manifest.json is not valid JSON: {e}")
        return None


def attribution_ids(problems):
    if not ATTRIBUTION_PATH.exists():
        problems.append(f"missing {ATTRIBUTION_PATH}")
        return set()
    ids = set()
    for line in ATTRIBUTION_PATH.read_text().splitlines():
        m = re.match(r"^\s*-\s*(\d{3})\b", line)
        if m:
            ids.add(m.group(1))
    return ids


def count_duplicate_paragraphs(text):
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    seen = {}
    dup = 0
    for p in paras:
        seen[p] = seen.get(p, 0) + 1
        if seen[p] > 1:
            dup += 1
    return dup, paras


def check_corpus(problems):
    manifest = load_manifest(problems)
    if manifest is None:
        return

    if manifest.get("graded_set") != GRADED_SET:
        problems.append(f"graded_set is {manifest.get('graded_set')!r}, expected {GRADED_SET!r}")

    docs = manifest.get("docs", [])
    expected_ids = [f"{i:03d}" for i in range(1, 31)]
    got_ids = [d.get("id") for d in docs]
    if len(docs) != 30:
        problems.append(f"manifest has {len(docs)} docs, expected 30")
    if got_ids != expected_ids:
        problems.append(f"doc ids not in order 001..030: got {got_ids}")

    attr_ids = attribution_ids(problems)
    genre_counts = {}
    original_cc0_count = 0
    seen_roles = {}

    for d in docs:
        did = d.get("id", "?")
        cat = d.get("category")
        lo, hi, (clo, chi) = CATEGORY_RANGES.get(cat, (None, None, (None, None)))
        try:
            idnum = int(did)
        except (TypeError, ValueError):
            problems.append(f"{did}: id is not numeric")
            idnum = None

        if idnum is not None and cat in CATEGORY_RANGES:
            if not (lo <= idnum <= hi):
                problems.append(f"{did}: category {cat!r} does not match id range")
        elif cat not in CATEGORY_RANGES:
            problems.append(f"{did}: unknown category {cat!r}")

        wr = d.get("word_range")
        if not (isinstance(wr, list) and len(wr) == 2 and clo is not None
                and clo <= wr[0] <= wr[1] <= chi):
            problems.append(f"{did}: word_range {wr!r} invalid for category {cat!r}")

        file_rel = d.get("file")
        fpath = HERE / file_rel if file_rel else None
        text = None
        if not fpath or not fpath.exists():
            problems.append(f"{did}: file {file_rel!r} does not exist")
        else:
            try:
                text = fpath.read_text(encoding="utf-8")
            except UnicodeDecodeError as e:
                problems.append(f"{did}: file is not valid UTF-8: {e}")
            if text is not None:
                real_words = len(text.split())
                if real_words != d.get("words"):
                    problems.append(f"{did}: manifest words={d.get('words')} but real count={real_words}")
                if wr and isinstance(wr, list) and len(wr) == 2:
                    if not (wr[0] <= real_words <= wr[1]):
                        problems.append(f"{did}: word count {real_words} outside range {wr}")
                dup, paras = count_duplicate_paragraphs(text)
                if dup > MAX_DUPLICATE_PARAGRAPHS:
                    problems.append(f"{did}: {dup} duplicated paragraphs (max {MAX_DUPLICATE_PARAGRAPHS})")
                for p in paras:
                    if "Topic 0" in p:
                        problems.append(f"{did}: paragraph contains forbidden text 'Topic 0'")
                if did == "020":
                    for ch in ".!?;:":
                        if ch in text:
                            problems.append(f"020: forbidden character {ch!r} still present")

        role = d.get("role")
        expected_role = ROLE_BY_ID.get(did)
        if expected_role and role != expected_role:
            problems.append(f"{did}: role={role!r}, expected {expected_role!r}")
        if not expected_role and role is not None:
            problems.append(f"{did}: role={role!r}, expected null")
        if role:
            seen_roles[role] = seen_roles.get(role, 0) + 1

        genre = d.get("genre")
        if genre:
            genre_counts[genre] = genre_counts.get(genre, 0) + 1

        license_ = d.get("license")
        if license_ not in ("public-domain", "CC-BY-SA-4.0", "original-CC0"):
            problems.append(f"{did}: invalid license {license_!r}")
        if license_ == "original-CC0":
            original_cc0_count += 1
        elif not d.get("source_url"):
            problems.append(f"{did}: fetched doc (license={license_!r}) missing source_url")

        if did not in attr_ids:
            problems.append(f"{did}: no ATTRIBUTION.md line found")

        if did in PDF_IDS:
            pdf_rel = d.get("pdf")
            ppath = HERE / pdf_rel if pdf_rel else None
            if not pdf_rel or not ppath.exists() or ppath.stat().st_size == 0:
                problems.append(f"{did}: pdf {pdf_rel!r} missing or empty")
        elif d.get("pdf") is not None:
            problems.append(f"{did}: pdf should be null")

    for genre, minimum in GENRE_MINIMUMS.items():
        if genre_counts.get(genre, 0) < minimum:
            problems.append(f"genre {genre!r} has {genre_counts.get(genre, 0)}, needs >= {minimum}")

    if original_cc0_count > MAX_ORIGINAL_CC0:
        problems.append(f"{original_cc0_count} docs are original-CC0, max is {MAX_ORIGINAL_CC0}")


TOKEN_RE = re.compile(r"[a-z0-9]+")
TOKEN_ONLY_RE = re.compile(r"^[a-z0-9]+$")
MIN_KEY_FACTS = 5
MAX_KEY_FACTS = 10
REQUIRED_FORBIDDEN = 3
MIN_TOKENS = 2
MAX_TOKENS = 4
MIN_KEYWORDS = 3
MAX_KEYWORDS = 5
MIN_RELATIONAL = 10


def doc_word_set(text):
    return set(TOKEN_RE.findall(text.lower()))


def check_facts(manifest, problems):
    """S0-04b: per-doc key facts, forbidden claims, keywords, and (005) relational checks.

    Returns (total_key_facts, total_forbidden_claims) across all docs; the counts are only
    meaningful when `problems` is still empty when this returns.
    """
    total_key_facts = 0
    total_forbidden = 0

    for d in manifest.get("docs", []):
        did = d.get("id", "?")
        facts_path = HERE / "corpus" / f"{did}.facts.json"

        if not facts_path.exists():
            problems.append(f"{did}: missing {facts_path.name}")
            continue

        try:
            facts = json.loads(facts_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            problems.append(f"{did}: {facts_path.name} is not valid JSON: {e}")
            continue

        file_rel = d.get("file")
        fpath = HERE / file_rel if file_rel else None
        if not fpath or not fpath.exists():
            problems.append(f"{did}: corpus file {file_rel!r} does not exist (checked by check_corpus)")
            continue
        text = fpath.read_text(encoding="utf-8")
        words = doc_word_set(text)

        # key_facts: 5-10, each a verbatim substring of the doc.
        key_facts = facts.get("key_facts")
        if not isinstance(key_facts, list) or not (MIN_KEY_FACTS <= len(key_facts) <= MAX_KEY_FACTS):
            problems.append(
                f"{did}: key_facts has {len(key_facts) if isinstance(key_facts, list) else 'invalid'} "
                f"entries, expected {MIN_KEY_FACTS}-{MAX_KEY_FACTS}"
            )
            key_facts = key_facts if isinstance(key_facts, list) else []
        for fact in key_facts:
            if not isinstance(fact, str) or fact not in text:
                problems.append(f"{did}: key_facts entry not found verbatim in doc: {fact!r}")
        total_key_facts += len(key_facts)

        # forbidden_claims: exactly 3, each with 2-4 lowercase alnum tokens absent from the doc.
        forbidden = facts.get("forbidden_claims")
        if not isinstance(forbidden, list) or len(forbidden) != REQUIRED_FORBIDDEN:
            problems.append(
                f"{did}: forbidden_claims has {len(forbidden) if isinstance(forbidden, list) else 'invalid'} "
                f"entries, expected exactly {REQUIRED_FORBIDDEN}"
            )
            forbidden = forbidden if isinstance(forbidden, list) else []
        for claim in forbidden:
            if not isinstance(claim, dict):
                problems.append(f"{did}: forbidden_claims entry is not an object: {claim!r}")
                continue
            tokens = claim.get("distinctive_tokens")
            if not isinstance(tokens, list) or not (MIN_TOKENS <= len(tokens) <= MAX_TOKENS):
                problems.append(
                    f"{did}: distinctive_tokens has "
                    f"{len(tokens) if isinstance(tokens, list) else 'invalid'} entries, "
                    f"expected {MIN_TOKENS}-{MAX_TOKENS} ({claim.get('claim')!r})"
                )
                tokens = tokens if isinstance(tokens, list) else []
            for tok in tokens:
                if not isinstance(tok, str) or not TOKEN_ONLY_RE.match(tok):
                    problems.append(f"{did}: distinctive_token not lowercase letters/digits: {tok!r}")
                elif tok in words:
                    problems.append(f"{did}: distinctive_token {tok!r} appears in the doc (must be absent)")
                elif tok not in claim_words(claim.get("claim", "")):
                    # A token the claim itself never uses can't identify that claim in a summary
                    # (Codex merge-gate review, PR #13). Digit separators are normalized: $52,750 -> 52750.
                    problems.append(f"{did}: distinctive_token {tok!r} is not in its own claim")
        total_forbidden += len(forbidden)

        # expected_oneline_keywords: 3-5.
        keywords = facts.get("expected_oneline_keywords")
        if not isinstance(keywords, list) or not (MIN_KEYWORDS <= len(keywords) <= MAX_KEYWORDS):
            problems.append(
                f"{did}: expected_oneline_keywords has "
                f"{len(keywords) if isinstance(keywords, list) else 'invalid'} entries, "
                f"expected {MIN_KEYWORDS}-{MAX_KEYWORDS}"
            )

        # relational_checks: only doc 005 has them, and it needs >= 10 with verbatim fields.
        relational = facts.get("relational_checks")
        if did == "005":
            if not isinstance(relational, list) or len(relational) < MIN_RELATIONAL:
                problems.append(
                    f"005: relational_checks has "
                    f"{len(relational) if isinstance(relational, list) else 'invalid'} entries, "
                    f"expected >= {MIN_RELATIONAL}"
                )
                relational = relational if isinstance(relational, list) else []
            for entry in relational:
                if not isinstance(entry, dict):
                    problems.append(f"005: relational_checks entry is not an object: {entry!r}")
                    continue
                for key in ("payer", "payee", "amount"):
                    val = entry.get(key)
                    if not isinstance(val, str) or val not in text:
                        problems.append(f"005: relational_checks[{key}]={val!r} not found verbatim in doc")
        else:
            if relational not in (None, []):
                problems.append(f"{did}: relational_checks should be absent or empty (only 005 has them)")

    return total_key_facts, total_forbidden


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus-only", action="store_true")
    args = ap.parse_args()

    problems = []
    check_corpus(problems)

    if problems:
        for p in problems:
            print(p)
        sys.exit(1)

    if args.corpus_only:
        print("30 docs OK, roles OK")
        sys.exit(0)

    manifest = load_manifest(problems)
    n_facts, m_forbidden = (0, 0)
    if manifest is not None:
        n_facts, m_forbidden = check_facts(manifest, problems)

    if problems:
        for p in problems:
            print(p)
        sys.exit(1)

    print(f"30 docs, {n_facts} facts, {m_forbidden} forbidden OK")
    sys.exit(0)


if __name__ == "__main__":
    main()
