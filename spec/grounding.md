# Grounding v3

The deterministic filter every generated bullet passes before it is shown or spoken. Shared by
web (`web/src/core/ground.ts`, S1-03) and Mac (`FruitbatCore`, S2-02). Fixtures:
`spec/fixtures/ground.json`. Argument: docs/PLAN.md C6 and PLAN-REVIEW-LOG.md (Codex R1 #10/#11,
R2 #11).

Grounding is a filter for the worst errors, not a truth guarantee. It catches a wrong number or an
invented name. It cannot catch a reversed relation or a dropped negation; the graded rubric
(`spec/eval/grade.md`) does that at release time, and "Read all" is always one key away.

## The rule

A bullet passes when both hold against **its own chunk's source text**:

1. **Numbers.** Every number in the bullet appears in the source, after normalizing both sides.
2. **Names.** Every name candidate in the bullet appears in the source (case-insensitive, after
   the same normalization), as a whole token.

A bullet that fails either is cut: never shown, never spoken, counted (`cut_bullets`). If every
bullet of a chunk is cut, the panel shows and speaks `notice.all_cut` and offers "Read this part"
as one key (rule 2). It never auto-plays a chunk the user did not ask for.

For One line, the per-chunk lines are grounded against their chunks, and the reduced line is
grounded against the surviving one-liners (see `spec/chunking.md`, One-line policy).

## Number normalization (both sides, in this order)

| Step | Example | Result |
|---|---|---|
| Strip thousands separators | `1,400` / `1 400` / `1.400` (only when the group is exactly 3 digits and no other dot) | `1400` |
| Strip currency symbols and codes glued to a number | `$5`, `€5`, `5 USD`, `USD 5` | `5` |
| Strip percent | `50%`, `50 percent`, `50 per cent` | `50` |
| Spelled-out numbers ≤ 100 → digits | `five`, `twenty-one`, `twenty one`, `a hundred` | `5`, `21`, `21`, `100` |
| Ordinals | `1st`, `third`, `21st` | `1`, `3`, `21` |
| Decimal and range punctuation kept | `3.5`, `2006–2010` | `3.5`, `2006`, `2010` |
| Case | `1,000 INSECTS` | `1000` |

A "number" is any maximal run matching `\d[\d,.\s]*\d|\d` after the spelled-out conversion, then
split on `–`, `-`, `/`, `:` into its parts; each part must appear in the source's normalized
number set. Years, dates, times, and counts are all just numbers. `1,000` in the source and
`1000` in the bullet match; `five percent` in the source and `5%` in the bullet match; `$5` in
the bullet and `5 dollars` in the source match; `1000` in the bullet and `100` in the source do not.

## Name candidates

Tokenize the bullet on whitespace, strip surrounding punctuation, keep the original case.
A token is a **name candidate** when it is capitalized (first letter upper, at least one letter)
and:

- it is **not sentence-initial**, or
- it is sentence-initial and **not** in the embedded common-word list and **not** in the stoplist.

Sentence-initial means the first token of the bullet, or the first token after `.`, `!`, `?`,
`:`, `;`, `—`, or an opening quote.

The stoplist: `The, A, An, It, They, This, These, That, We, He, She, I, You, Here, There, Then`.

The common-word list is `spec/common-words.txt`: the 5,000 most frequent English words,
lowercase, one per line. Source: Peter Norvig, `count_1w.txt` (Google Web Trillion Word Corpus,
first 5,000 rows, lowercased; fetched 2026-09-23 from https://norvig.com/ngrams/count_1w.txt).
Both targets embed the file as-is; it is looked up lowercase.

Hyphenated and possessive forms are compared on their base: `Marcus's` → `marcus`,
`White-nose` → `white-nose` and also `white`, `nose`. Multi-word names are checked token by token.
All-caps tokens of 2–5 letters (`USA`, `NPS`) are name candidates unless the lowercase form is a
common word (`OK`, `TV` are not; `NPS` is).

### Why the rule is shaped this way

- `They feed at night` vs. source `Bats feed at night`: `They` is sentence-initial and in the
  stoplist → not a candidate → passes. Paraphrase survives.
- `Carol paid Bob $5` vs. source `Alice paid Bob $5`: `Carol` is sentence-initial, not a common
  word, not in the stoplist → candidate → not in source → **cut**. The invented name is caught
  even though the source has other capitalized names (Codex R2 #11).
- `Bob paid Alice $5` vs. source `Alice paid Bob $5`: passes. This is the reversed relation the
  filter cannot see; the graded rubric and `spec/eval/*.facts.json` `relational_checks` cover it.
- `Bats eat 1,000 insects an hour` vs. source `up to 1000 insects in one hour`: `1,000` → `1000`
  → passes.
- `Bats eat 100 insects an hour` vs. the same source: `100` not in `{1000, 1}` → **cut**.

## Counters (RunStats, `spec/schemas/run-stats.schema.json`)

`bullets_total`, `bullets_cut`, `cut_rate = bullets_cut / bullets_total`, `all_cut_chunks`.
Acceptance: cut rate at Short ≤ 10 % (informational); any `halluc_flags` in the bench is a block.
