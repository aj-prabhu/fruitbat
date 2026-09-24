# Grading prompt

Run this prompt in a Claude or Codex session to grade one generated output (one doc, one dial
level). Produces one row in `bench/graded/<commit>-<doc>-<level>.json`.

## Inputs (gather all four before scoring anything)

1. **Full source text** — `spec/eval/corpus/<doc>.txt`. Read the whole file, not an excerpt.
2. **The output** — the bullets (or the one line) the pipeline generated for `<doc>` at
   `<level>`, plus the commit (`git rev-parse HEAD` or the commit under test).
3. **The facts file** — `spec/eval/corpus/<doc>.facts.json` (`key_facts`, `forbidden_claims`,
   `relational_checks` for doc `005`, `expected_oneline_keywords`).
4. **The level and its caps** — `<level>` is one of `short` / `caveman` / `oneline` (`readall`
   is never graded here: it is verbatim playback, not a summary), plus that level's bullet-count
   and length caps from `spec/dial.json`. Coverage is judged against what a summary of that
   length could hold, not against the full `key_facts` list unconditionally.

Never score from the facts file alone. A reversed relation or a dropped negation is invisible
without the source text in front of you.

## Procedure

1. **Check every bullet (or the one line) against the source.** For each claim, find the
   sentence(s) in the source it's based on. Flag any claim the source doesn't support, any
   reversed relation, any dropped negation, and any invented number, name, or entity.
2. **Check each `key_facts` entry.** For each one, decide if the output's substance covers it
   (exact wording is not required). Record `key_facts_hit` (how many are covered) out of
   `key_facts_total` (`len(key_facts)`).
3. **Check each `forbidden_claims` entry.** For each one, decide if the output asserts that
   claim (in substance, not just by containing its `distinctive_tokens` — that token check is
   `score.py`'s automated proxy, not what a human/LLM grader judges). Record `forbidden_hits`.
4. **For doc `005` only, check each `relational_checks` entry.** Confirm the output states the
   correct `payer`/`payee`/`amount` direction, and does not contradict any `negated_phrases`
   entry (e.g. does not say "not $400" happened, does not drop a "never"). Record
   `relational_failures` (count of entries the output gets wrong).
5. **Score the three rubric scales** (`spec/eval/rubric.md`): `faithfulness`, `coverage`,
   `clarity`, each 1-5. Any forbidden-claim hit or relational failure caps `faithfulness` at 1.
6. **`score`** is `min(faithfulness, coverage, clarity)`.

## Output row

Append exactly this JSON object (one line, or pretty-printed — either is fine) to
`bench/graded/<commit>-<doc>-<level>.json`:

```json
{
  "commit": "<sha>",
  "doc": "011",
  "level": "short",
  "score": 4,
  "faithfulness": 5,
  "coverage": 4,
  "clarity": 4,
  "key_facts_hit": 7,
  "key_facts_total": 9,
  "forbidden_hits": 0,
  "relational_failures": 0,
  "graded_by": "claude",
  "notes": "one short summary of what, if anything, was wrong"
}
```

`graded_by` is `"claude"`, `"codex"`, or `"human"` — whichever ran this prompt. `relational_failures`
is `0` for every doc except `005`. `notes` is one line; leave it empty (`""`) only when the score
is a clean 5/5/5.

**`scripts/release-check.sh` requires every graded file's `score >= 4`.** A doc/level combination
that scores below 4 blocks the release until the prompt, chunking, or grounding change that
caused it is fixed and the doc is re-graded.
