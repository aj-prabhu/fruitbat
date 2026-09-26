# ADR 0001: Web summarizer model and configuration for `web-v0.1.0`

Status: accepted (S1-05, 2026-09-24). Builds on ADR 0000 (runtime).

## Context

The plan locks the candidate set under the 700 MB cold budget (C12): default
`onnx-community/Qwen3.5-0.8B-Text-ONNX` q4f16 (470 MB), fallback A `Qwen2.5-0.5B-Instruct`
q4f16 (483 MB), fallback B `Qwen3-0.6B-ONNX` q4f16 (570 MB), low-end tier
`SmolLM2-360M-Instruct` q4f16 (273 MB), voice Kokoro q8 92 MB. S0-03's CPU try-outs found the
0.8B model ignores bullet counts (asks for 5, writes 10–19), so the parser cap enforces the
per-chunk caps and the bake-off had to test whether WebGPU numerics, a system prompt, or smaller
chunks change that. The cut list allows a 2-candidate × 3-doc bake-off for `web-v0.1.0`.

## What was built (S1-05)

- `web/src/workers/llm.worker.ts`: the model lives in a worker; the 1-token probe runs after the
  on-demand download; a memory failure on load retries once with the low-end tier; abort via
  `InterruptableStoppingCriteria`; `runId` on every message.
- `web/src/engine/llm.ts`: probe (adapter/device only, on load), `ensureLoaded` (download only on
  a summary request or the explicit button, size from `spec/models.json`), chunk → generate →
  `BulletParser` (caps from `spec/dial.json`) → grounding v3 per bullet against its chunk →
  all-cut notice; One line: per-chunk lines, reduce ≤ 10 per group, depth ≤ 2, grounded against
  the survivors, > 50 % cut → Short with `notice.oneline_failed`; input limit → `notice.input_limit`.
- `web/src/workers/llm.fake.worker.ts` + `spec/fixtures/fake-llm.json`: the `?llm=fake` worker
  for `wasm-ci` (deterministic bullets, `?delay=`, abort honored, `?fake=cutall|think|011`).
- `web/src/engine/capabilities.ts`: probe, `saveData`, mobile, `?inject=`, `?llm=`, `?model=`,
  `?prompt=system`, `?chunk=`.
- `web/summarize.html` (`window.__llm`) drives the e2e tests and the bake-off.

## Bake-off (M1 Pro, Chrome for Testing 153, WebGPU, warm model, 1 rep)

| model | doc | level | variant | chunks | kept / total (cut) | ttfa ms | tok/s | gen ms | facts hit (lite) | one-line kw | notices |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---|
| default | 005 | short |  | 1 | 6 / 6 (0) | 1805 | 43 | 5120 | 60 |  |  |
| default | 005 | caveman |  | 1 | 5 / 5 (0) | 1045 | 39.3 | 3050 | 50 |  |  |
| default | 005 | oneline |  | 1 | 1 / 1 (0) | 1124 | 27.8 | 1115 |  | 25 |  |
| default | 011 | short |  | 2 | 12 / 12 (0) | 2102 | 38 | 8809 | 22 |  |  |
| default | 011 | caveman |  | 2 | 10 / 10 (0) | 2039 | 33.9 | 6160 | 11 |  |  |
| default | 011 | oneline |  | 2 | 1 / 2 (0) | 3557 | 20.9 | 3441 |  | 25 |  |
| default | 025 | short |  | 10 | 57 / 57 (0) | 3108 | 34.6 | 60596 | 80 |  |  |
| default | 025 | caveman |  | 10 | 49 / 50 (1) | 2900 | 29.4 | 40868 | 20 |  |  |
| default | 025 | oneline |  | 10 | 1 / 10 (0) | 22045 | 13.5 | 20888 |  | 50 |  |
| default | 011 | short | system | 2 | 12 / 12 (0) | 2834 | 38.1 | 8557 | 33 |  |  |
| default | 011 | short | chunk600 | 3 | 18 / 18 (0) | 1483 | 43 | 15338 | 22 |  |  |
| fallback-a | 005 | short |  | 1 | 0 / 0 (0) |  | 26.9 | 8172 | 0 |  |  |
| fallback-a | 005 | caveman |  | 1 | 0 / 0 (0) |  | 27.4 | 4376 | 0 |  |  |
| fallback-a | 005 | oneline |  | 1 | 0 / 0 (0) |  | 27.8 | 10071 |  | 0 | notice.oneline_failed |
| fallback-a | 011 | short |  | 2 | 0 / 0 (0) |  | 22.7 | 19416 | 0 |  |  |
| fallback-a | 011 | caveman |  | 2 | 0 / 0 (0) |  | 21 | 11414 | 0 |  |  |
| fallback-a | 011 | oneline |  | 2 | 0 / 0 (0) |  | 21.7 | 25845 |  | 0 | notice.oneline_failed |
| fallback-a | 025 | short |  | 10 | 0 / 0 (0) |  | 17.8 | 123531 | 0 |  |  |
| fallback-a | 025 | caveman |  | 10 | 0 / 0 (0) |  | 16.6 | 72397 | 0 |  |  |
| fallback-a | 025 | oneline |  | 10 | 0 / 0 (0) |  | 17 | 165047 |  | 0 | notice.oneline_failed |

Cold loads in this run: default 28.5 s (probe 0.13 s), fallback A 26.2 s (probe 0.6 s); the earlier
e2e run measured the low-end tier at 14.4 s. `ttfa_ms` is measured from the summary request on a
loaded model to the first grounded bullet; the cold number (download included) is in
`tests/summarize.spec.ts`'s first case and ADR 0000 (about 40 s at 100 Mbps).

Raw outputs: `bench/last-run/<level>-<doc>[-variant][-model].txt` (`short-011.txt` committed as
the proof artifact, the rest gitignored).

## Decision

1. **Ship the default: `onnx-community/Qwen3.5-0.8B-Text-ONNX` q4f16 on WebGPU**, revision
   `1e45daba…`, prompts as written in `spec/dial.json`. Every doc and level produced grounded
   bullets; 1 cut in 165 bullets; warm decode 28–43 tok/s (the ≥ 15 gate), first bullet 1–3.5 s
   warm on single-chunk docs.
2. **Fallback A (`Qwen2.5-0.5B-Instruct` q4f16) is out.** On this runtime (Transformers.js 4.3.0,
   onnxruntime-web 1.31 dev, Chrome for Testing 153, Apple M1 Pro) it decodes to degenerate text
   ("To / Cant / D / E / F / F / F…") at every level and doc: 0 bullets parsed. Same failure class
   the plan expected on Safari for q4f16; here it is the model at q4f16. Its `q4` (786 MB) and
   `fp16` (997 MB) builds are over the cold budget, so there is no in-budget variant to try.
3. **The working fallback is the low-end tier, `SmolLM2-360M-Instruct` q4f16** (273 MB): the
   `?inject=oom` e2e case loads it for real and it summarized 011 at Caveman with 10 kept, 0 cut,
   39 tok/s. It becomes the tier the worker retries with on a memory failure, and the candidate
   for machines that cannot hold the default. Fallback B (`Qwen3-0.6B-ONNX` q4f16, 570 MB) was
   not run tonight; S1-14's browser matrix should try it on Safari before it is relied on.
4. **Bullet counts are enforced by the parser cap, not the prompt.** The system-prompt variant and
   600-token chunks changed nothing about count obedience (the model still wrote past the cap and
   the cap dropped the rest: 6 per chunk at Short). 600-token chunks give more, shorter chunks (3 on
   011) and a faster first bullet (1.5 s vs 2.1 s) at the cost of more total output; not adopted
   for v0.1.0, worth a bench row later. Caveman bullets run over the 9-word cap (`parser_overlength`
   counted, bullets kept), so the Caveman prompt needs another pass in S1-14's graded work.
5. **One line quality is the open risk.** On 011 the reduce step picked a secondary point
   ("Decontaminate before entering a cave…", keyword hit 25 %) and on 025 the reduced line is a
   plot detail (50 %); the acceptance table wants ≥ 80 %. The reduce prompt should prefer the
   document's opening chunk, or the app should skip reduce on ≤ 2 chunks and take the first
   chunk's line; decide in S1-14 with the graded pass. 005's one line ("Bob owed Alice $45, not
   $120, and Dev owed Carla $40, not $400.") is exact.

## Consequences and what is still owed

- `tests/summarize.spec.ts` proves per-chunk bullets, no `<think>`, the three injected failures,
  zero model requests before the first summary request, One line → Short fallback, and abort on
  the fake worker. It does not measure the graded rubric.
- S1-13 owes the `RunStats` rows for these numbers (3 reps, medians, bench identity) and S1-14
  owes the 18 graded files; `release-check.sh` blocks the tag without them.
- `facts_hit_lite` in the table is the bake-off runner's own 60 %-of-content-words heuristic,
  not `bench/score.py` (S0-05, not merged when this ran). Treat it as a rough ordering only.
- The system-prompt and 600-token-chunk variants are in `capabilities.ts` behind URL flags for
  the bench only; the product path uses the `spec/dial.json` prompts as written.
