# bench/

The measurement half of docs/PLAN.md rule 3 ("No merge without a bench run") and the KPI table.
Everything here is stdlib-only Python 3 (no `jsonschema`, no network calls) so it runs the same
in a CI runner, a contributor's laptop, or a release checkout with nothing installed.

## What's here (S0-05) vs. what's coming (S1-13)

This packet built the **schemas, the scorer, and the gate** — the contract every future bench row
has to satisfy. It did **not** build the runner that actually drives the web/Mac pipeline and
appends rows: that's `bench/run.sh`, packet S1-13. Until S1-13 merges, `bench/results.csv` has a
header and no rows, `bench/baselines.json` has an empty `baselines` list, and every PR carries the
`bootstrap` label so `bench/gate.py --pr-head` passes with "runner not yet available" instead of
failing on a runner that doesn't exist yet (docs/PLAN.md rule 3's bootstrap exemption).

**Contract for S1-13:** `bench/run.sh` must append one `RunStats`-shaped row to
`bench/results.csv` per rep, in the exact column order of its header (which is
`spec/schemas/run-stats.schema.json`'s property order — see `bench/gate.py`'s `CSV_FIELDS`), with
`""` for a null metric. Three reps per bench identity (`bench/identity.md`); `bench/gate.py`
takes the median across whatever rows share an identity, so 1–3 rows per identity both work, but
the acceptance table's numbers assume 3. Rows are committed in a separate commit on top of the
tested commit (rule 3) so `git diff --quiet <row.commit> HEAD -- . <evidence-pathspec>` stays
empty.

## Files

| File | What |
|---|---|
| `results.csv` | Bench rows. Header only until S1-13. Columns = `RunStats` keys, fixed order. |
| `baselines.json` | `{"version": 1, "baselines": [...]}`. Each entry is a `RunStats`-shaped object: the identity fields plus the **median** metric values recorded as "known good", plus `commit`/`date` for provenance. Empty until the first baseline PR. |
| `score.py` | Scores one generated output against one corpus doc: `facts_token_hit`, `halluc_flags`, `forbidden_hits`, `oneline_keyword_hit`, `coverage` (passthrough). |
| `gate.py` | The merge gate. `--self-test`, `--pr-head`, `--release`. See its module docstring. |
| `schema_check.py` | Stdlib JSON Schema (draft 2020-12) subset validator for `spec/schemas/*.json`. |
| `example-row.json` / `example-report.json` | Valid `RunStats` / `BugReport` instances, used as smoke tests for the schemas and as a format reference. |
| `identity.md` | The bench identity tuple, and why `browser`/`os` use major versions. |

## `score.py`

```
python3 bench/score.py --doc 011 --level short --output /path/to/bullets.txt
```

Reads `spec/eval/corpus/<doc>.txt` (source) and `<doc>.facts.json` (key facts / forbidden claims
/ oneline keywords), reads the output file as one blob (bullet formatting doesn't matter — the
scorer only looks at words and numbers), and prints a JSON object:

- **`facts_token_hit`** — share of `key_facts` that count as "hit". A `key_fact` doesn't carry a
  precomputed token list the way `forbidden_claims` do, so `score.py` derives up to 3 "distinctive
  tokens" per fact automatically (numbers ≥ 10 or with a decimal point rank highest, then
  capitalized/acronym words, then the longest remaining non-stopword words — the same intuition as
  `spec/grounding.md`'s name candidates), then requires **all** of them to appear in the output
  (mirroring how `forbidden_hits` is defined). This is a blunt proxy, not the grounding filter and
  not the graded rubric (`spec/eval/grade.md`) — it can't see a reversed relation or a paraphrase
  that legitimately drops a secondary number, and its acceptance floors (docs/PLAN.md's Stage 1
  table: ≥ 90 % Short / 75 % Caveman / 60 % One line) are tuned against real model output in the
  S1-05 bake-off, not against this scorer's design alone.
- **`halluc_flags`** — count of numbers in the output that don't appear in the source, both sides
  normalized the way `spec/grounding.md` normalizes numbers (thousands separators, currency and
  percent stripped by the extraction itself, spelled-out numbers and ordinals ≤ 100 converted to
  digits). Counts occurrences, not distinct values.
- **`forbidden_hits`** — count of `forbidden_claims` whose `distinctive_tokens` **all** appear, as
  whole lowercase words, in the output (literally what `spec/eval/validate.py` already checks are
  *absent* from the source corpus doc — here we check for their accidental *presence* in the
  generated output).
- **`oneline_keyword_hit`** — share of `expected_oneline_keywords` present as a case-insensitive
  substring. Only computed at `--level oneline`; `null` otherwise.
- **`coverage`** — `readall` only: a straight passthrough of `--coverage`. The real coverage
  number (offset tiling + duration additivity on doc `020`) is computed by the TS/Swift harness
  (S1-03/S1-04), not here; `score.py` just carries it into the JSON shape `gate.py` expects.

`readall` never gets `facts_token_hit` / `halluc_flags` / `forbidden_hits` / `oneline_keyword_hit`
— it's verbatim playback, not a summary (`spec/eval/grade.md`), and only `coverage` applies.

## `gate.py`

Three modes; see the module docstring for the full contract:

- `--self-test` — 10 self-tests against the pure gating logic (no filesystem/network beyond a
  couple of throwaway `git init` repos in a temp dir). `10/10 self-tests passed` on success.
- `--pr-head --base <sha> --head <sha> [--allow-baseline-reset] [--labels a,b]` — what CI's
  `bench-gate` job runs. Finds valid rows (rule 3's evidence rule), groups by bench identity,
  medians each group, gates against `bench/baselines.json`. No valid rows: the `bootstrap` label
  (from `--labels` or `GITHUB_EVENT_PATH`) passes with a note; otherwise it's a fail — a PR isn't
  exempt from bench just because it forgot to run the bench.
- `--release --commit <sha>` — the live/release gate (S1-16, `scripts/release-check.sh`). Same
  evidence rule, but **no bootstrap exemption** and **no baseline comparison** — a release is
  checked against the acceptance-table floors directly, because "the environment changed" is not
  a reason to ship below the bar you'd use `baseline-reset` for on a PR.

### What actually gates a PR (docs/PLAN.md S0-05 packet text)

Regression checks (vs. the stored baseline for the same identity):

| Metric | Fails when |
|---|---|
| `ttfa_ms` | current > baseline × 1.20 |
| `tok_s` | current < baseline × 0.85 |
| `facts_token_hit` | baseline − current ≥ 0.05 (5 points) |
| `halluc_flags` | current > baseline (any increase) |
| `forbidden_hits` | current > baseline (any increase) |
| `gap_ms` | current > baseline + 50 |
| `peak_mb` (Mac only) | current > baseline × 1.25 |

Absolute floors (acceptance table; apply regardless of baseline, including under
`baseline-reset`):

| Metric | Floor |
|---|---|
| `tok_s` | ≥ 15 (web), ≥ 40 (mac) |
| `ttfa_ms` | ≤ 3 s readall / ≤ 8 s short-caveman-oneline (web, warm); ≤ 1.5 s / ≤ 4 s (mac, warm); ≤ 90 s (web, cold) |
| `facts_token_hit` | ≥ 0.90 short, ≥ 0.75 caveman, ≥ 0.60 oneline |
| `oneline_keyword_hit` | ≥ 0.80 |
| `halluc_flags`, `forbidden_hits` | 0 |
| `stop_ms` | ≤ 200 |
| `coverage`, `tts_overlimit` (readall) | 1.0, 0 |
| `peak_mb` (Mac) | ≤ 4096 |

`cut_rate` is tracked but never blocks (the KPI table marks it informational).

### `--allow-baseline-reset` (the `baseline-reset` label)

Skips the regression comparison for this PR's rows and, if the floors still pass, replaces the
stored baseline for that identity with the PR's medians. It does **not** waive the floors — an
environment change is a reason to stop comparing against stale history, never a reason to ship
below the product's absolute bar.

## `schema_check.py`

```
python3 bench/schema_check.py <instance.json> <schema.json>
```

A small stdlib subset of JSON Schema draft 2020-12: `type` (including nullable via
`["number","null"]`), `required`, `additionalProperties` (boolean), `properties`, `items`,
`enum`, `minimum`/`maximum`, `maxLength`/`minLength`, `pattern`, and `$ref` — both within one
document (`#/$defs/Name`) and to a sibling schema file (`run-stats.schema.json` or
`run-stats.schema.json#/$defs/Name`). It exists because the committed bench code has to run with
no dependency beyond the standard library; if a `jsonschema` venv is available it's a fine second
opinion, but `schema_check.py` is what CI and a bare Python 3 checkout actually run.

## The runner (S1-13)

`bench/run.sh --target web [--docs N|id,id,...] [--levels all|level,level,...] [--cache warm|cold] [--reps N] [--port PORT]`
dispatches to `bench/web/run.mjs` (`--target mac` prints `S2-13` and exits 2 -- not built yet).

`run.mjs`:

1. Refuses to run on a dirty tree (only `bench/results.csv`, `bench/baselines.json`,
   `bench/last-run/` may be dirty) so the row's `commit` is unambiguous.
2. `npm run build` once, then serves the build with `npx vite preview --port <PORT> --strictPort`
   (killed at exit). The build embeds the tested commit into every row automatically
   (`web/vite.config.ts`'s `__FRUITBAT_COMMIT__`, read by `web/src/stats/store.ts`) -- the runner
   doesn't stamp `commit` itself.
3. Launches the bundled Chromium **headed**, WebGPU on (`--enable-unsafe-webgpu
   --ignore-gpu-blocklist`), audio muted. `--cache warm` uses one persistent profile
   (`bench/.profile-warm/`, gitignored) for the whole run, so models download once into that
   profile's Cache API; `--cache cold` gives every rep its own temp profile, removed after. A warm
   run does one throwaway "short" request first to prime the cache (discarded, not scored, not
   counted in the reps) so the recorded rows are never accidentally `cache_state: "cold"`.
4. For each doc x level x rep: `setDocId(doc)`, `run(text, level)`, then polls `state()` until
   `gen` is `done`/`failed` **and** `settledRunId` equals the run -- the exact same condition
   `web/src/main.tsx` itself uses before calling `stats.record()`, so by the time the poll
   resolves the app has already written a fresh `RunStats` row to its own `localStorage` (read via
   `window.__fruitbat.rows()`, last entry). The runner does not build a row from scratch: it takes
   that row and fills in only what the browser genuinely cannot know --
   `facts_token_hit`/`halluc_flags`/`forbidden_hits`/`oneline_keyword_hit` from `bench/score.py`
   against `state().bullets`, and `peak_mb`/`heap_mb` (see `bench/web/memory.md`).
5. Validates the filled-in row with `bench/schema_check.py` before appending it to
   `bench/results.csv` in the schema's column order; a rejected row aborts the run rather than
   being silently dropped.
6. Prints a summary table (doc, level, median `ttfa_ms`/`tok_s`/`facts_token_hit`/`cut_rate`
   across that identity's reps).

`readall` rows skip `score.py` entirely (`facts_token_hit` etc. stay `null` -- it's verbatim
playback, not a summary; see `bench/score.py`'s own docstring).

## Keeping `model_id`'s enum in sync

`spec/schemas/run-stats.schema.json#/$defs/model_id` is a closed enum, not a free string, because
the packet spec calls `model_id` out as one of `RunStats`'s enum fields. When `spec/models.json`
pins a new model (a new fallback tier, the Mac summarizer once S2-03a lands, a second voice),
add its `id` to that enum in the same PR — a one-line schema change, reviewed like any other.
