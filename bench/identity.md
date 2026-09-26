# Bench identity

Two `RunStats` rows are "the same measurement, repeated" — and so eligible to be grouped into
one median and gated against one baseline — when every field below matches:

```
(target, model_id, model_rev, dtype, device, browser, browser_major, os, os_major,
 machine_id, cache_state, doc_id, level)
```

`bench/gate.py`'s `Identity` NamedTuple is exactly this tuple, in this order. Everything else in
`RunStats` (`ttfa_ms`, `tok_s`, `facts_token_hit`, …) is a **metric**, not part of identity: it's
the thing gate.py compares across rows that share an identity, or against `bench/baselines.json`.
`commit` and `date` are provenance, not identity — a regression check is explicitly a comparison
*across* commits for the *same* identity.

## Why major versions, not exact ones (v4)

`browser` and `os` are recorded as **major-version-qualified** pairs: `browser` + `browser_major`,
`os` + `os_major` (e.g. `chrome`/`130`, `macos`/`15`). A baseline keyed to the exact browser patch
(`130.0.6723.58`) would go stale on every silent auto-update and force a `baseline-reset` PR every
few weeks for no real regression. A baseline keyed to the major version only re-baselines when the
browser or OS actually crosses a version boundary that could plausibly change performance —
matching how the acceptance table itself is scoped ("Chrome", "M1 Pro"), not to a specific build.

## `machine_id`

`sha256(hostname)[:12]` on Mac (a stable-but-anonymous per-machine identity, so a slower CI runner
doesn't get compared against Akshay's M1 Pro). **On web, `machine_id` is the literal string
`"web"`** unless the bench harness injects a real one (v4) — browser benchmarking has no
reliable, privacy-safe hardware fingerprint by default, and `"web"` groups all web measurements
together rather than fragmenting baselines by an identity component the harness usually can't
fill in honestly.

## What this buys

- **Apples to apples.** A regression check never compares a WebGPU run against a WASM one, or a
  cold cache against a warm one, or `short` against `oneline` — those are different products of
  the pipeline with different acceptance floors (docs/PLAN.md's Stage 1 acceptance table).
- **No baseline yet ⇒ fail, loudly.** `bench/gate.py --pr-head` refuses to invent a baseline for
  an identity it hasn't seen before; the fix is a small PR to `bench/baselines.json` (or the
  `baseline-reset` label when the environment itself changed, not the code).
- **Growth is additive.** A new model, device, or bench identity in general (e.g. `S2-03a` pinning
  the Mac summarizer) just adds new baseline entries and new `model_id` enum values in
  `spec/schemas/run-stats.schema.json`; it never invalidates an existing identity's history.
