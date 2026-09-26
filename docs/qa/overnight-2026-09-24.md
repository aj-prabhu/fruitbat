# Fruitbat build status (overnight 9/23 → 24, day 2 9/25, merge run 9/25 → 26)

_Updated Sat 2026-09-26 09:40 PDT._

## Where it stands

- **Main has the real app end to end:** paste or highlight, pick a level, WebGPU summary, spoken bullets, Read all, dial regeneration, the 4-level canned demo, the loading screen, the stats store, and the privacy proof with its CSP.
- **Merged since Friday night:** #16 S1-05 summarizer, #26 CI fix, #17 S1-04 voice, #6 S1-15 release, #5 S2-00 Mac checklist, #11 S0-06 health check, #18 S1-06 orchestrator, #21 S1-12 privacy, #22 S1-10 stats, #20 S1-09 loading + demo.
- **Merged before that:** #1 #2 #7 (Thu), #3 #4 #8 #13 #15 #9 #10 #12 #14 (Fri).
- **Still open, in merge order:** #23 S1-11 bug report, #24 S1-13a test model cache, #25 S1-07 panel UI, #28 strings-check fix, #27 S1-13 bench runner, #19 this report.

## How the merges went

- Every merge re-ran the Codex review on the PR's own branch. Every PR had green CI before its merge from #17 on.
- Since Friday night: about 127 findings fixed and 11 declined, each tagged in the ledger with a reason.
- Rounds per PR: #18 took 13, #16 12, #17 11, #6 and #20 7 each, most others 1 to 5.
- From 00:15 Saturday the rule was: fix every P1 and every P2 about honesty or a dead feature, and decline narrow repeats with a reason.
- **One slip:** #16 merged with red CI. The red was the flake below plus a missing `bootstrap` label, not a code break.

## Things found on the way (worth knowing)

1. **CI was flaky since #2.** Tests acted before the coi-serviceworker's one-time reload. Fixed in #26 with `tests/isolated.ts` (`gotoIsolated`); every spec now uses it.
2. **The strings check was failing on main** once #20 merged, and nothing noticed because only `release-check.sh` ran it. The regex read TypeScript generics and `>=` as JSX text. #28 parses TSX with TypeScript and runs the check in CI.
3. **`cache_state` was wrong on every bench row.** Cached files also fire progress events, so every load looked cold. The loader now counts real network bytes per load (#22).
4. **Stats rows were recorded before the run's audio metrics were final.** They now record on an explicit "run settled" signal (#22). The bench runner in #27 waits on the same signal.
5. **Notices used to play over bullets.** A notice raised during a summary now joins the ordered voice stream (#18).
6. **The context-scope privacy recorder** now sees service-worker traffic. The only new request was the service worker re-fetching the page itself (#21).
7. From Friday, still true: the Hub CDN adds redirect parameters over time (`xip` on 9/25); Fallback A (Qwen2.5-0.5B) outputs garbage; Kokoro on WASM runs at about RTF 1.15; the 0.8B model's One-line keyword hit is 25–50 % against an 80 % gate.

## Not done yet

- **Your two product ideas:** a fruit bat Wikipedia demo, and a "fruits eaten" counter. Recon and a draft plan are in `docs/plans/2026-09-26-fruit-bat-demo-and-fruits-eaten.md`, waiting on four answers from you.
- **The S1-12 real-model privacy sweep:** it writes `docs/qa/privacy-requests-<sha>.json`. It needs a visible WebGPU browser, which takes window focus, so it's yours (see blocked.md).
- **Bench baselines:** #27 has 36 proof rows. Setting baselines from them is your call.
- **S1-14:** Safari. **S1-16:** live gate and `web-v0.1.0`. **S1-L1**, **S1-L4**, **S2-01/02**.

## Blocked on you

See `docs/qa/blocked.md`.
