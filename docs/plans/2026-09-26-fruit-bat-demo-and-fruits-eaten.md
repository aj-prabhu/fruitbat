# Fruit bat demo + "fruits eaten" counter — recon and draft plan

_Claudex loop, Phase 0 (recon) only, 2026-09-26. Nothing is built. Phases 1–3 need your answers and
sign-off; the questions are at the top._

## Your ideas (from chat, 9/25)

- The first-run demo summarizes the fruit bat Wikipedia page.
- A "fruits eaten" count: how many summaries you've had, like VoiceInk's metrics.

## Decisions I need from you (load-bearing only)

1. **What counts as one fruit?**
   - Recommendation: every summary that finishes (Short, Caveman, One line), not Read all.
   - Why it matters: it decides whether the number means "summaries" or "anything read aloud".
   - If I guess wrong: the number feels inflated or stingy. It's cheap to change later.
2. **Is "minutes saved" worth showing?**
   - Recommendation: yes, next to the count, as "about N minutes saved".
   - The honest formula: the time to read the source at 238 words per minute, minus the time you spent listening to the summary.
   - Why it matters: it's the VoiceInk-style number that makes the counter feel real. A made-up formula would be dishonest.
   - If I guess wrong: we show a number you don't believe. It's easy to drop.
3. **Where does it show?**
   - Recommendation: a small line in the panel header ("12 fruits eaten"), with the full numbers in the Stats view.
   - Pip, the bat, could get a tiny fruit animation per summary. That's S1-08 territory, so not now.
4. **Wikipedia's license is CC BY-SA 4.0. OK with visible credit?**
   - Recommendation: yes. The demo shows "From Wikipedia, 'Megabat', CC BY-SA 4.0" with a link. The demo's text, JSON and audio are marked CC BY-SA in the repo, separate from the AGPL code.
   - If you'd rather avoid share-alike: the current NPS bat article is public domain, and we keep it.

Or say "accept all recommendations" and I'll go.

## Assumptions ledger (confirm or correct in one pass)

1. The article is Wikipedia's **"Megabat"**; "Fruit bat" redirects there. — source: Wikipedia.
2. The demo stays a **prefix excerpt** under the 4 MB-per-WAV budget, as today. `make-demo-main.mjs` already trims the pool sentence by sentence to fit. — source: `web/scripts/lib/make-demo-main.mjs` (READALL_BUDGET_BYTES 3.9 MB).
3. The article text is **fetched once by the build script** and committed, as `web/public/demo/source.txt` plus a `source.json` with the URL, revision id and license. The app never contacts Wikipedia, so the privacy rule and `spec/network.json` don't change. — source: rule 4 and net.ts.
4. The demo is **regenerated with the same pinned models and voice** (Qwen3.5-0.8B on CPU, Kokoro af_heart). Bullets go through the real parser and grounding. — source: `make-demo-main.mjs`.
5. The counter is **local only**, in its own `localStorage` key. It is not the stats rows (capped at 200) and is never in bug reports or exports unless you choose. — source: `web/src/stats/store.ts` (RETENTION 200), privacy rule.
6. **"Clear stats" also resets the counter**, one reset for everything. — source: convention; tell me if the counter should survive.
7. **Visible text goes through the Voice Bank** (S1-L0 rule): the counter line, the credit line, the Stats labels. — source: rule 8.

## Draft plan (for Phase 2 Codex review once you've answered)

- **Demo:**
  - Add a `--source wikipedia:Megabat` mode to `make-demo.mjs`. It fetches plain text (the MediaWiki extracts API), strips references, and records the revision id.
  - Regenerate the four tracks, then commit the text, JSON and WAV together.
  - Add the credit line to `Demo.tsx` from `spec/strings`, and update `README` and `NOTICE` with the CC BY-SA scope.
  - Proof: the loading spec still passes, the demo offsets point into `source.txt`, and each WAV is ≤ 4 MB.
- **Counter:**
  - `web/src/stats/fruits.ts` holds `{ fruits, words_in, words_out, listened_s }`.
  - It updates on the orchestrator's `settledRunId` for finished summaries, like stats rows.
  - Shown in the panel header and the Stats view, and reset by "Clear stats".
  - Proof: unit tests for counting, reset, and a corrupt-storage fallback; one e2e with `?llm=fake` checks the count goes up by one per summary.
- **Builder:** per your Weekly Ledger direction table, the arm with fewer branches. I'll check it at Phase 3.
