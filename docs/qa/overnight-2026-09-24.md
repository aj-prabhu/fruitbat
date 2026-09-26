# Fruitbat build status (overnight 9/23 → 24, day 2 9/25)

_Updated Fri 2026-09-25 18:10 PDT. Merged: #1, #2, #7 (by Claude at your "merge them", 13:21; then the auto-mode classifier refused further merges). Everything else is open._

## Merge order (all PRs target `main`; a stacked PR's body says what it sits on)

| # | PR | Packet | Sits on | State |
|---|---|---|---|---|
| — | #1 ✓ | S0-02 house rules + CI | | merged |
| — | #2 ✓ | S1-00a walking skeleton | | merged |
| — | #7 ✓ | S0-04a eval corpus | | merged |
| 1 | #3 | S1-00b dev Space deploy | | classifier refused this merge ("dangerous", no reason given) |
| 2 | #4 | S1-03a tokenizer, loader, net | #3 | + `xip` Hub drift fix (57a1bb7) |
| 3 | #8 | S0-03 shared spec | #3 | |
| 4 | #13 | S0-04b facts, rubric, grader | | |
| 5 | #15 | S0-05 schemas, bench gate | #13 | |
| 6 | #9 | S1-01 web scaffold | #4, #8 | |
| 7 | #10 | S1-L0 product copy | #9 | |
| 8 | #12 | S1-02 intake | #9 | |
| 9 | #14 | S1-03 core text ops | #9 | |
| 10 | #16 | S1-05 summarizer engine | #14, #10 | |
| 11 | #17 | S1-04 voice engine | #14, #10 | |
| 12 | #18 | S1-06 orchestrator | #16, #17, #12 | real app works end to end here |
| 13 | #20 | S1-09 loading UX + 4-level canned demo | #18 | |
| 14 | #21 | S1-12 privacy proof + CSP + PRIVACY.md | #18 | webgpu-local sweep still to run on a quiet network |
| 15 | #22 | S1-10 stats store | #18, #15 | |
| 16 | #23 | S1-11 bug report + issue form | #22 | GitHub prefill screenshot is your step |
| 17 | #24 | S1-13a test model cache (Playwright) | #18, #20, #21 | suite 20+ min with timeouts → ~11 min |
| 18 | #25 | S1-07 panel UI | #20 | axe 0 serious/critical |
| — | #5 | S2-00 Mac toolchain checklist | | |
| — | #6 | S1-15 release.yml + release-check | #3 | |
| — | #11 | S0-06 weekly health (NICE) | #6 | |
| — | #19 | docs: this report + blocked items | | |

Every PR got a Codex review on creation; every P1 and P2 was fixed and pushed, or declined with a reason (one, on #23) and tagged in the ledger. Nothing was re-reviewed; the merge hook re-runs it. Several fixes to shared engine files (`llm.ts`, `orchestrator.ts`, `tts.ts`) were applied on more than one stacked branch; merging in the order above should reconcile them, but expect a few trivial conflicts in those three files.

`bench-gate` fails on #16 onward until S1-13's runner lands, or you apply the `bootstrap` label by hand.

## Where the product is

- On `pkt/S1-07-panel-ui` (top of the stack): paste or highlight, pick a level, it summarizes on WebGPU and speaks; the panel shows bullets as spoken with the current one marked, the rate slider, pause/skip/stop, Read-all's current sentence large. A 4-level canned demo ("Try it now") plays in under a second with no model download. Stats store and bug report built.
- Dev Space live (skeleton); the app deploys there on the first push to `main` after #3 merges. `2shay/fruitbat` stays private until `web-v0.1.0`.

## Findings worth reading before merging

1. **Hub drift (found 9/25):** the CDN redirect gained a new query parameter `xip`; `net.ts` refused every real-network model load until it was added to `spec/network.json` (#4). Redirect parameter names will drift again; the weekly health check (#11) should diff them.
2. **Fallback A (Qwen2.5-0.5B q4f16) decodes to garbage** on this runtime; out. SmolLM2-360M is the OOM tier. (#16)
3. **Kokoro q8 on WASM runs at RTF ~1.15.** Read-all early gaps ~3.4 s; bullet streams ~0.5 s. WebGPU Kokoro didn't load in 10 min. An in-flight synthesis can't be aborted, so after Esc the next first audio waits up to one segment. (#17, #18)
4. The 0.8B model ignores bullet counts; the parser cap enforces them. **One-line keyword hit 25–50 % vs the 80 % gate.** (#8, #16)
5. Playwright's `route.fulfill()` crashes Chromium for ~90 MB bodies; the test cache serves big files through a same-origin dev proxy instead. `page.route()` misses Worker fetches; `context.route()` catches them. (#24)
6. The whole `wasm-ci` suite only passes reliably when one agent runs tests at a time (shared CPU and network).
7. GitHub still reads `LICENSE` as "other".

## Not done yet (plan order)

- S1-13 bench runner (second half): next, one agent.
- S1-08 Pip: the static placeholder is in #25; animation is NICE.
- S1-14 browser matrix + graded pass: Chrome is covered by the suites; Safari needs a real Safari run.
- S1-16 live gate, `web-v0.1.0`: needs your sign-off, and the merges first.
- S1-L1 application text (due Oct 2), S1-L4 demo-day runbook, S2-01/S2-02 (Mac, from Oct 1).

## Blocked on you

See `docs/qa/blocked.md`. Short version: the rest of the merges; the LICENSE call; Xcode 26 + the mlx skill copy (Oct 1); the GitHub prefill screenshot (#23).
