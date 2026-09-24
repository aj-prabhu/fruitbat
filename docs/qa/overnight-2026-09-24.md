# Overnight build 2026-09-23 → 24

Loop ran 22:52 → 09:05 PDT on Fable 5.1, auto mode. **18 PRs open, nothing merged.** Two usage-limit windows (00:40 → 03:10, 04:19 → 08:10) cost about 6.5 hours; everything below survived them.

## Merge order (all PRs target `main`; stacked ones say what they sit on)

| # | PR | Packet | Sits on | Codex review (all findings fixed unless noted) | Proof |
|---|---|---|---|---|---|
| 1 | #1 | S0-02 house rules + CI | | 1 P1 + 3 P2 + 1 P1 from #11 | CI green |
| 2 | #2 | S1-00a walking skeleton, local | | 6 P2 over four rounds | webgpu-local: 6 bullets, first audio 40 s cold |
| 3 | #3 | S1-00b deployed to the dev Space | #2 | 2 P2 | same test green on the dev URL |
| 4 | #7 | S0-04a eval corpus | | 2 P2 | 30 docs OK (verified by me) |
| 5 | #4 | S1-03a tokenizer, loader, net | #3 | 4 P2 + 1 from #9 | 19 unit tests; `resolve/main` root cause fixed |
| 6 | #8 | S0-03 shared spec | #3, #7 | 3 P2 | proofs on real 011 |
| 7 | #13 | S0-04b facts, rubric, grader | #7 | 2 P2 | 30 docs, 262 facts, 90 forbidden |
| 8 | #15 | S0-05 schemas, bench gate | #13 | 1 P1 + 2 P2 | 10/10 self-tests |
| 9 | #9 | S1-01 web scaffold | #4, #7, #8 | 2 P2 | 26 unit + 6 smoke |
| 10 | #10 | S1-L0 product copy (118 strings) | #9 | none | strings-check OK; voice capture logged |
| 11 | #12 | S1-02 intake: chip, ⌥R, paste | #9 | none | 42 unit + 14 e2e |
| 12 | #14 | S1-03 core text ops | #9 | 3 P2 | 54 core tests |
| 13 | #16 | S1-05 summarizer engine | #14, #10 | 1 P1 + 2 P2 | real WebGPU proof, fake worker for CI |
| 14 | #17 | S1-04 voice engine | #14, #10 | 2 P1 + 4 P2 | read-all coverage/additivity/stop proofs |
| 15 | #18 | S1-06 orchestrator | #16, #17, #12 | 1 P1 + 4 P2 | 117 unit, 34 e2e; real app run |
| — | #5 | S2-00 Mac toolchain checklist | | 1 P2 | mitmproxy installed |
| — | #6 | S1-15 release.yml + release-check | #3 | 2 P1 + 2 P2 | dry runs pasted; no tag pushed |
| — | #11 | S0-06 weekly health (NICE) | #1, #6 | 1 P1 + 1 P2 | proof pasted |

Every Codex finding was fixed and pushed; none re-reviewed (the merge-time hook re-runs). `bench-gate` will fail on #16, #17, #18 until S1-13 lands or you apply the `bootstrap` label by hand. CI on stacked PRs only appears after #1 merges.

## Where the product is

- **The real app works end to end** on the S1-06 branch: paste or highlight text at `/`, pick a level, it summarizes on WebGPU and speaks with Kokoro. Cold: summarizer load 33.7 s, first bullet +2.1 s, 35 tok/s, first audio 43.3 s after the click, 12 bullets / 0 cut on the sample article, worst gap 499 ms.
- Dev Space live: https://2shay-fruitbat-dev.static.hf.space (skeleton at `/skeleton.html`; the app deploys on the first push to `main`). `2shay/fruitbat` exists, **private** until `web-v0.1.0`.
- The walking skeleton gate (Thu EOD) is met a day early.

## Findings to read before merging

1. **Fallback A (Qwen2.5-0.5B q4f16) decodes to garbage** on this runtime. Out. Low-end SmolLM2-360M works (OOM retry). Fallback B untested. ADR 0001, #16.
2. **Kokoro q8 on WASM: RTF 1.15–1.19.** Read-all early gaps 3.4 s; bullet streams 499 ms. The ≤ 150 ms gap KPI is out of reach on this path. Transformers.js 4.3.0 has no `q8f16` dtype and Kokoro fp32/`q8f16`-by-filename on WebGPU did not finish loading in 10 min. An in-flight ORT synthesis cannot be aborted (Esc, then up to ~4 s before the next first audio). #17, #18.
3. The 0.8B model ignores bullet counts; the parser cap enforces them. **One-line keyword hit 25–50 %** vs the 80 % gate. Caveman bullets run over 9 words. #8, #16.
4. Transformers.js 4.3.0 fetched `tokenizer_config.json` at `resolve/main`; pinned by the loader (#4). Real redirect hosts: `us.aws.cdn.hf.co` (signed params) and `huggingface.co/api/resolve-cache`; the COI service worker hides them from page-level capture (#3).
5. `011.txt` is 2 chunks with the real tokenizer (#14). Evidence files (bench rows, graded files, privacy log) are validated by ancestry + clean diff, not by their own SHA (#6, #15).
6. GitHub reads `LICENSE` as "other" (3-line brand note on top of the AGPL text). Options in `docs/qa/blocked.md`.

## Not done (in plan order), none blocked on you

S1-07 panel UI, S1-08 Pip, S1-09 loading UX + canned demo, S1-10 stats store, S1-11 bug report, S1-12 privacy proof + CSP, S1-13 bench runner, S1-14 browser matrix, S1-16 live gate, S1-L1/L2/L4, S2-01, S2-02. Each depends on #18 (or #15 for S1-10). I stopped at 09:05 rather than spend your daytime usage window on them; relaunch the loop tonight or dispatch by hand. Also not done: the NICE drop zone (S1-02), the throwaway-PR CI proof (S0-02), the live `web-v0.0.1-test` tag (S1-15), `gh workflow run health.yml` (S0-06): all need a merge to `main` first.

## Blocked on you (details in `docs/qa/blocked.md`)

- Codex cannot build from an auto-mode session (`codex exec --yolo` is denied by the classifier). Every Codex-tagged packet was built by Claude with the PR hook's read-only Codex review as the cross-check. Rerun any of them via `codex-build` from a real terminal if you prefer.
- GitHub license detection ("other").
- Xcode 26 install; `mlx-swift-lm` skill copy into `~/.claude/skills` and `~/.codex/skills` (an agent may not write there).
- The planning repo was kept at `~/Sites/fruitbat-planning` (+ a bundle) because the classifier refused `rm -rf .git`; delete when you like.

## Process notes

- A Haiku corpus attempt produced templated filler with a false "validator passed" claim; discarded and redone by Sonnet with real public-domain sources. Every later subagent report was re-verified by running its proof.
- Playwright reused another worktree's preview server once and tested the wrong build; fixed in #16 (never reuse; `PW_PORT` per worktree).
- Voice capture for S1-L0: `2026-09-24-fruitbat-strings` (teaching channel).
