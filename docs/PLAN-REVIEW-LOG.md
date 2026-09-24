# Plan Review Log: Fruitbat
Phases 0-1 (recon + interrogation) complete — plan locked with Akshay 2026-09-23. MAX_ROUNDS=2.
Reviewer: Codex (codex-cli 0.155.1, config `model = "gpt-6-astra"`), read-only sandbox, same thread across rounds.
Then: one Fable fresh-eyes pass (Agent tool, model fable, read-only), logged below the Codex rounds.

## Round 1 — Codex
_thread 01a0d0f0-492c-7500-8466-f6b47262e3ee, 2026-09-23 18:06 PDT, read-only_

Read `PLAN.md`, `BRIEF.md`, and the research document. No `CONTEXT.md` or ADRs exist yet. No files changed.

1. **P1 — The default model and runtime are incompatible as specified.** [PLAN.md:99](/Users/akshay/Sites/reader-app/PLAN.md:99) specifies Transformers.js v3, but Qwen3.5 support is listed among [v4 additions](https://github.com/huggingface/transformers.js/releases/tag/4.0.0). Model-file existence does not prove runtime compatibility.  
   **Fix:** Pin a tested runtime/ONNX/model combination and require real browser generation before implementing dependent packets.

2. **P1 — Kokoro revision pinning will silently fail.** [S1-04](/Users/akshay/Sites/reader-app/PLAN.md:241) assumes `models.json` pins everything; the current [loader](https://raw.githubusercontent.com/hexgrad/kokoro/main/kokoro.js/src/kokoro.js) does not forward `revision`, and [voice downloads](https://raw.githubusercontent.com/hexgrad/kokoro/main/kokoro.js/src/voices.js) default to `resolve/main`.  
   **Fix:** Specify a pinned adapter or vendored assets for weights, tokenizer, and voices; assert actual download URLs contain the expected revisions.

3. **P1 — The Space deployment combines incompatible build strategies.** [S1-01](/Users/akshay/Sites/reader-app/PLAN.md:222) configures `npm run build`, while S1-15 uploads only built assets and README—no package manifest or sources to build. [HF’s build configuration](https://huggingface.co/docs/hub/spaces-sdks-static) also expects `app_file` to identify the generated entry point.  
   **Fix:** Upload prebuilt assets with `app_file: index.html` and no build command, or upload complete sources with `app_file: dist/index.html`.

4. **P1 — The privacy “proof” permits obvious exfiltration.** [S1-12](/Users/akshay/Sites/reader-app/PLAN.md:297) would accept `GET https://huggingface.co/?text=CANARY-7f3a`: allowed host, empty body. It omits URL/header leaks, encoded values, socket traffic, and native network behavior; CI’s WASM fallback never exercises summarization.  
   **Fix:** Restrict requests to declared methods/resource paths, inspect all outbound channels, test encoded canaries and failure paths, and require native plus real-WebGPU evidence.

5. **P1 — Synthesized ⌘C contradicts the absolute privacy promise.** [S2-06](/Users/akshay/Sites/reader-app/PLAN.md:391) places selected text on the general pasteboard, which [participates in Universal Clipboard](https://developer.apple.com/documentation/appkit/nspasteboard?changes=_2); clipboard managers may capture it before restoration.  
   **Fix:** Remove automatic ⌘C fallback from the strict-private path; offer explicit clipboard intake or local OCR instead.

6. **P1 — Clipboard restoration can destroy newer clipboard contents.** [S2-06](/Users/akshay/Sites/reader-app/PLAN.md:391) does not distinguish failed copy, delayed copy, or another app/user copying during the 300 ms window; unconditional restoration can overwrite their new data or summarize stale text.  
   **Fix:** If retained, specify change-count ownership, timeout rejection, preservation of all pasteboard representations, and restore only while the operation still owns the contents.

7. **P1 — “Read all” can silently omit text.** [S1-04](/Users/akshay/Sites/reader-app/PLAN.md:244) relies on sentence streaming, but [kokoro-js explicitly truncates exceptionally long chunks](https://raw.githubusercontent.com/hexgrad/kokoro/main/kokoro.js/src/kokoro.js). A long unpunctuated paragraph defeats the promised escape hatch.  
   **Fix:** Split oversized sentences to verified TTS token limits, retain source offsets, and test complete coverage through the final input token.

8. **P1 — Cancellation does not prevent stale speech.** [S1-06](/Users/akshay/Sites/reader-app/PLAN.md:258) flushes audio and aborts the LLM, but an already-running TTS request can complete afterward and refill the queue; overlapping selections introduce the same race. “Current chunk” is ambiguous when generation runs ahead of playback.  
   **Fix:** Tag every callback with a run generation ID, reject stale results, track the playback cursor separately, and test delayed completion after stop/dial/new-input events.

9. **P1 — Streaming lacks backpressure and an executable concurrency model.** [Architecture](/Users/akshay/Sites/reader-app/PLAN.md:91) requires simultaneous generation and playback, while S1-06 models `summarizing` and `speaking` as sequential states. No worker boundary or queue limit prevents inference from blocking Esc or accumulating an entire document’s PCM.  
   **Fix:** Define independent generation/playback states, worker-owned inference, bounded queues, and pause/stop/resource-release behavior under load.

10. **P1 — The faithfulness gate can reward false summaries.** [S0-05](/Users/akshay/Sites/reader-app/PLAN.md:207) checks names/numbers, so “Alice paid Bob $50” and “Bob paid Alice $50” can score identically; negation also passes. `forbidden_claims` and one-line keywords are created but never scored.  
    **Fix:** Rename token overlap as a diagnostic, add relational/negation fixtures, and make a defined factuality review mandatory for release.

11. **P1 — Grounding rejects valid paraphrases without guaranteeing truth.** [PLAN.md:94](/Users/akshay/Sites/reader-app/PLAN.md:94) treats every capitalized word as a name: “They feed at night” fails against “Bats feed at night.” All bullets may disappear, and no empty-result behavior is specified.  
    **Fix:** Define actual entity/number normalization, include sentence-initial-word fixtures, and visibly fall back to Read all when every bullet is rejected.

12. **P1 — Bench comparisons are neither comparable nor enforceable.** [S0-05](/Users/akshay/Sites/reader-app/PLAN.md:207) joins only target/model/level, ignoring document, hardware, revision, dtype, browser, and cache state. First-run passes can bless arbitrarily bad results; gap/memory gates advertised later are absent, and no Stage 1 required merge check runs the gate.  
    **Fix:** Specify matched benchmark identities, repetitions/aggregation, absolute thresholds, deliberate baseline approval, and a required check tied to the reviewed commit.

13. **P1 — The model-selection criteria disagree with the live gate.** [S1-05](/Users/akshay/Sites/reader-app/PLAN.md:252) measures time until a bullet reaches TTS, whereas the KPI measures actual playback; selection allows 85% facts versus the KPI’s 90%. The 1.4 GB candidate plus even 92 MB voice needs roughly 119 seconds at 100 Mbps before initialization, exceeding the cold gate.  
    **Fix:** Use one end-to-end acceptance table, including total download budget, and reject candidates against it before selection.

14. **P1 — The Mac fallback changes the supported product.** [PLAN.md:117](/Users/akshay/Sites/reader-app/PLAN.md:117) promises macOS 14+, then relies on macOS 26 WebGPU if native engines fail. No packet establishes the embedded origin, native bridge, cache, cancellation, or CLI/bench parity.  
    **Fix:** Spike the embedded engine early and explicitly raise its minimum OS, or choose a fallback that satisfies macOS 14 and the existing interfaces.

15. **P1 — `ChatSession` can contaminate unrelated summaries.** [S2-03](/Users/akshay/Sites/reader-app/PLAN.md:370) never specifies session lifetime; [MLX’s session retains conversation state until cleared](https://github.com/ml-explore/mlx-swift-lm/blob/main/Libraries/MLXLMCommon/ChatSession.swift). Reusing it across documents/chunks introduces prior text, growing context, and invalid benchmark comparisons.  
    **Fix:** Reuse model weights but create isolated generation sessions per chunk/reduction, with cross-document contamination and context-reset tests.

16. **P1 — Packet dependencies are not executable as written.** [S0-03](/Users/akshay/Sites/reader-app/PLAN.md:183) tests corpus files without depending on S0-04a; S1-01 requires the bat article without that dependency; S1-03 requires the web test environment without S1-01. S1-08 expects amplitude events that S1-06 never promises.  
    **Fix:** Correct hard dependencies and assign explicit interface/fixture owners before dispatching parallel packets.

17. **P1 — September 29 has no demonstrated critical path or scope cutoff.** [Calendar](/Users/akshay/Sites/reader-app/PLAN.md:39) leaves engine compatibility, integrated performance, Safari, and hosting validation until immediately before launch; every merge also requires one human, and all UI extras block S1-14.  
    **Fix:** Require a deployed real-text → real-summary → real-audio spike by September 24, then define a dated cutoff deferring nonessential packets while preserving the summary live gate.

18. **P2 — WebGPU detection is insufficient.** [S1-05](/Users/akshay/Sites/reader-app/PLAN.md:251) checks only adapter availability, then assumes q4f16 works; initialization failure, unavailable required features, device loss, and allocation failure have no specified recovery.  
    **Fix:** Probe the selected runtime/model configuration, test failure injection, and preserve working Read all when summarization fails.

19. **P2 — “One line” and chunk limits are underspecified.** [S0-03](/Users/akshay/Sites/reader-app/PLAN.md:186) cannot simultaneously preserve sentence boundaries and enforce a hard word cap on an oversized sentence. Bullet caps are ambiguous per-document versus per-chunk, and the reduced line has no defined grounding source or bounded recursive reduction.  
    **Fix:** Define token budgets with output reservation, oversized-sentence splitting, cap scope, reduction limits, and final-output grounding explicitly.

20. **P2 — The memory KPI measures the wrong thing.** [PLAN.md:522](/Users/akshay/Sites/reader-app/PLAN.md:522) uses `performance.memory` to enforce total web memory, but it reports an [unreliable JavaScript heap estimate](https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory), not total inference/GPU memory.  
    **Fix:** Measure browser process/GPU memory with a documented local harness and report heap separately; mark unavailable measurements explicitly.

21. **P2 — Stats and benchmark schemas conflict.** [S1-10](/Users/akshay/Sites/reader-app/PLAN.md:286) promises bench columns but disallows strings needed for commit/revision/date; S1-13 requires non-null decode rate and factuality for Read all, which has no LLM. Append-only localStorage has no retention or quota handling.  
    **Fix:** Create one versioned schema with validated metadata, nullable inapplicable metrics, bounded retention, and storage-failure handling.

22. **P2 — Several proofs can pass without proving completion.** [S2-03](/Users/akshay/Sites/reader-app/PLAN.md:372) greps `/tmp/out.txt` without creating it; S1-05’s grep checks only literal tags, not valid nonempty output; row-count and fixture-count assertions do not establish correctness.  
    **Fix:** Make proofs fail on missing/empty artifacts and assert each acceptance criterion directly, including real generated audio and complete output.

23. **P2 — MLX audio’s dependency/resource assumptions are stale.** [S2-04](/Users/akshay/Sites/reader-app/PLAN.md:377) assumes an eSpeak path, while current [Kokoro documentation](https://raw.githubusercontent.com/Blaizzy/mlx-audio-swift/main/Sources/MLXAudioTTS/Models/StyleTTS2/Kokoro/README.md) describes downloaded G2P resources, and the [package](https://raw.githubusercontent.com/Blaizzy/mlx-audio-swift/main/Package.swift) requires Swift tools 6.2. No exact library revision or complete auxiliary-asset manifest is specified.  
    **Fix:** Pin and compile the actual dependency graph, inventory/license all downloaded assets, and prove warm offline synthesis before accepting the spike.

24. **P2 — Polar’s happy-path test leaves licensing semantics undefined.** [S2-11](/Users/akshay/Sites/reader-app/PLAN.md:425) omits product-benefit binding, validation using the stored activation ID, deactivation, and when offline grace starts; validating only the key does not establish the intended activation policy. The [API exposes these identifiers](https://polar.sh/docs/api-reference/2026-04/customer_portal/validate-license-key).  
    **Fix:** Specify request/response fields, persisted last-success time, explicit revocation handling, device transfer, and wrong-benefit/missing-activation tests.

25. **P2 — Update and release promises are incomplete.** [PLAN.md:120](/Users/akshay/Sites/reader-app/PLAN.md:120) forbids network calls required by Sparkle; S2-12 leaves the stable appcast URL and submitted archive ambiguous. `spctl` on the build machine does not prove the downloaded DMG installs offline; Apple requires notarizing a [supported distribution container](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).  
    **Fix:** Document update endpoints and an exact sign/package/notarize/staple/publish sequence, then test the quarantined download and update on a clean machine.

26. **P2 — Issue-form prefill can lose the report.** [S1-11](/Users/akshay/Sites/reader-app/PLAN.md:293) assumes `body=` populates YAML form fields; [GitHub supports field-specific query parameters](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue). The 6,000-character cap also fails to specify whether it applies before URL encoding.  
    **Fix:** Use explicit form field IDs or a Markdown template, cap the final encoded URL, and verify the complete report survives the opened form.

VERDICT: REVISE

### Claude's response to Round 1

Accepted 26/26 in substance; two partial rejections noted. PLAN.md rewritten as v2.

- 1 Runtime compat → **accepted.** Pinned Transformers.js 4.x; new packet S1-00 (walking skeleton, deployed, due Thu 9/24 EOD) proves real generation before any dependent packet; ADR 0000 records versions.
- 2 Kokoro pinning → **accepted.** `env.remotePathTemplate` with revision hash for model files; the 6 voices vendored into the Space at a pinned commit; privacy test asserts the hash in every Hub URL.
- 3 Space build config → **accepted.** Prebuilt `dist` + README with `app_file: index.html`, no `app_build_command` (decision C10).
- 4 Privacy proof → **accepted.** Method + exact URL-prefix allowlist, canary in URL/headers/body incl. encoded and base64 forms, stubbed WebSocket/RTC/beacon/EventSource, request-count match, `check-network.sh` in CI, Mac `NetworkPolicy` + `nettop` audit in S2-14, WebGPU run is part of the live gate.
- 5 ⌘C vs privacy → **accepted.** Clipboard fallback is opt-in with a warning (C9); AX-only by default; clipboard hotkey is user-initiated.
- 6 Clipboard restore races → **accepted.** changeCount ownership, single-advance check, all types preserved, restore only while we own it, four test cases.
- 7 Read-all truncation → **accepted.** TTS-safe splitting with measured limit (S1-00), source offsets, coverage test on an unpunctuated 600-word doc, rule 2 strengthened.
- 8 Cancellation races → **accepted.** `runId` on every message, stale drops, separate playback/generation cursors, delayed-completion and rapid re-select tests.
- 9 Backpressure/concurrency → **accepted.** LLM and TTS in Web Workers, bounded queues (3 in flight, 30 s PCM), independent `gen`/`play` states, Esc on main thread.
- 10 Faithfulness gate → **partially accepted.** Token overlap stays as the *regression* gate (deterministic, catches wrong numbers/names) but is renamed `facts_token_hit` and no longer called a truth measure; forbidden claims and one-line keywords are now scored; relational/negation fixtures added; graded rubric pass is mandatory for releases and model/prompt changes. *Rejected:* making the token check purely informational — it still blocks the class of regression it can see.
- 11 Grounding false negatives → **accepted.** v2 normalization, sentence-initial rule, stoplist, fixtures, all-cut fallback reads the chunk aloud with a message.
- 12 Bench comparability → **accepted.** Full identity tuple, 3 reps/median, absolute floors, reviewed baselines (no auto-pass on first run), gap + memory gates, CI `bench-gate` on committed rows for the PR HEAD.
- 13 Selection vs live gate → **accepted.** One acceptance table (incl. ≤ 600 MB cold budget) used by both the bake-off and the live gate; the 1.4 GB model is out of the default path.
- 14 Mac fallback changes the product → **accepted.** S2-03a spike with a decision on Oct 3; safety net explicitly raises the floor to macOS 26 via ADR 0003 with its own packets.
- 15 ChatSession contamination → **accepted.** One session per chunk/reduction; contamination test.
- 16 Packet dependencies → **accepted.** S0-04a before S0-03 and S1-01; S1-03 after S1-01; interfaces named with owners (`__fruitbat` hook in S1-01, `AnalyserNode` + offsets in S1-04, `countTokens` in S1-05).
- 17 9/29 critical path → **accepted.** Walking skeleton Thu, scope cutoff Sat EOD, MUST/NICE lists, twice-daily merge batches, critical path drawn.
- 18 WebGPU probe → **accepted.** Probe = real 1-token generation; failure injection modes; Read all preserved.
- 19 One-line/chunk limits → **accepted.** Token budgets with output reservation, oversized-sentence rule, per-chunk caps, reduction groups ≤ 10 / depth ≤ 2, reduction grounded against the one-liners.
- 20 Memory KPI → **partially accepted.** Web memory = renderer + GPU RSS via a documented harness, JS heap reported separately, **informational** until validated; Mac RSS remains a gate. *Rejected:* dropping the web number entirely — reported, not gated.
- 21 Schema conflict → **accepted.** One versioned `spec/stats.schema.json` for stats, bench, and reports; validated metadata strings; nullable metrics; retention 200; quota handling.
- 22 Weak proofs → **accepted.** Every proof now fails on a missing/empty artifact and asserts the criterion (`test -s`, bullet counts, coverage, non-empty audio).
- 23 mlx-audio-swift assumptions → **accepted.** Pinned revisions, downloaded-asset inventory with licenses, warm offline synthesis test in S2-03a; Swift 6.4 satisfies tools 6.2.
- 24 Polar semantics → **accepted.** Activate/validate/deactivate fields, `benefit_id` binding, `activation_id` in validate, `last_validated_at` persisted, grace defined, per-case messages and tests.
- 25 Sparkle/release → **accepted.** Appcast URL fixed, update check disclosed and switchable (rule 1d), full sign→notarize app→staple→DMG→notarize DMG→staple sequence, quarantined-download test on a clean account.
- 26 Issue prefill → **accepted.** Per-field query params, cap on the final encoded URL (8,000), manual prefill screenshot.

## Round 2 — Codex
_same thread, 2026-09-23 18:17 PDT, read-only_

Most round-1 findings are addressed. Both partial rejections are reasonable: token overlap can remain a regression diagnostic, and web memory can remain informational. The following material issues remain. No files changed.

12. **P1 — The revised bench rule is impossible to satisfy.** [Rule 3 and S0-05](/Users/akshay/Sites/reader-app/PLAN.md:236) require committed rows containing that same PR HEAD’s hash; committing the rows changes HEAD again. Foundation packets also require benchmarks before the runner exists.  
    **Fix:** Attach benchmark artifacts to an immutable tested SHA outside the commit, and explicitly exempt bootstrap packets until the runner is operational.

4. **P1 — The privacy test still accepts text in URLs.** [S1-12](/Users/akshay/Sites/reader-app/PLAN.md:327) checks canaries in headers/body, but not URLs; an allowed model URL with `?text=CANARY-7f3a` still passes prefix checking. Same-origin URLs are unrestricted, and matching request counts does not fix this. Native `nettop` evidence shows destinations, not transmitted content.  
   **Fix:** Check URL contents too, constrain paths/query parameters, and require payload-level native tests through the actual dependency download paths.

7. **P1 — Offset coverage still does not prove untruncated speech.** [S1-04](/Users/akshay/Sites/reader-app/PLAN.md:277) equates the final segment’s `onEnd` with the last word being audible. Truncated audio can finish normally while retaining offsets claiming the entire input. S1-00’s “find where output stops covering input” has no defined measurement.  
   **Fix:** Assert the exact phonemized/tokenized input fits before every synthesis call with truncation disabled, then separately verify audible completion on the long-input fixture.

10. **P1 — The graded truth gate covers only Short.** [Release checklist](/Users/akshay/Sites/reader-app/PLAN.md:478) allows Caveman and One line—including their separate prompts and reduction—to ship without factuality grading. The grader receives facts.json rather than the full source, so it cannot reliably assess additional claims.  
    **Fix:** Grade source-grounded outputs from every summarizing level, including multi-chunk reduction and relational/negation cases, before releases and relevant prompt changes.

13. **P1 — The stated fallback cannot meet the new budget.** [Model choices and acceptance table](/Users/akshay/Sites/reader-app/PLAN.md:110) give Qwen3-0.6B as 570 MB and the smallest voice model as 92 MB: already 662 MB against a 600 MB cap. Even the default 470 MB candidate cannot use the offered 326 MB WebGPU voice configuration.  
    **Fix:** Lock an eligible combined LLM/TTS configuration and identify a measured fallback under budget, or explicitly revise the budget and cold-start gate.

16. **P1 — A dependency cycle remains hidden behind an estimate.** [S1-03](/Users/akshay/Sites/reader-app/PLAN.md:270) needs `countTokens()` from S1-05, which depends on S1-03. The substitute word count ×1.3 cannot enforce a hard token budget. S0-03 also specifies CPU prompt testing without selecting a CPU-compatible artifact/dtype.  
    **Fix:** Move tokenizer loading/counting into an earlier independent packet and name the supported runtime/artifact for the prompt proof.

21. **P1 — “One schema” still contradicts the report contract.** [S0-05](/Users/akshay/Sites/reader-app/PLAN.md:236) allows only validated metadata strings; S1-10 must reject free-text fields, but S1-11 uses that same schema for `user_description`, UA, GPU information, and nested events. An executor must either break reports or weaken stored-metrics privacy.  
    **Fix:** Define a strict reusable `RunStats` schema and a separate `BugReport` envelope whose explicitly user-entered description is never persisted as run metrics.

27. **P1 — The corpus specification is internally impossible.** [S0-04a](/Users/akshay/Sites/reader-app/PLAN.md:215) requires ten short documents of 300–600 words, ten medium, and ten long, but assigns `010.txt` a roughly 1,200-word article; the expected numbering convention puts it among the short documents. The unpunctuated ≥600-word fixture also has no assigned category/file.  
    **Fix:** Provide an explicit manifest mapping each document ID to its category, permitted word range, and special-fixture role.

6. **P2 — A single clipboard change does not establish ownership.** [Mac intake](/Users/akshay/Sites/reader-app/PLAN.md:145) calls the next change count “the value we produced,” but a failed ⌘C plus another app’s copy produces the same observation. The fallback then reads unrelated text and may overwrite it during restoration.  
   **Fix:** Remove automatic copy/restore and retain the explicit clipboard hotkey; change-count checks alone cannot make this ownership claim.

5. **P2 — The unconditional privacy claim remains false in opt-in mode.** [Goal and rule 1](/Users/akshay/Sites/reader-app/PLAN.md:10) still promise that text never leaves the device, while C9 correctly acknowledges that the enabled clipboard fallback can expose it to syncing services. Consent makes the feature a choice; it does not make the absolute statement accurate.  
   **Fix:** Qualify the privacy promise consistently wherever the opt-in clipboard feature is available.

11. **P2 — Grounding explicitly lets invented sentence-initial names through.** [Grounding v2](/Users/akshay/Sites/reader-app/PLAN.md:103) only treats a sentence-initial token as a name if it already appears capitalized mid-sentence in the source. Thus “Carol paid Bob $5” passes against “Alice paid Bob $5”: Carol is never checked.  
    **Fix:** Add this counterexample and define entity detection independently of whether the candidate name already exists in the source.

19. **P2 — Long-document limits and One-line fallback still conflict.** [Pipeline rules](/Users/akshay/Sites/reader-app/PLAN.md:96) allow reduction groups of ten with depth two, but impose no input limit or behavior beyond that capacity. An all-cut intermediate chunk must also be read aloud, contradicting “only [the final line] is spoken.”  
    **Fix:** Define maximum accepted input and reduction-overflow behavior, plus one explicit One-line policy for failed intermediate summaries.

25. **P2 — The network policy blocks the updater’s download path.** [S2-01](/Users/akshay/Sites/reader-app/PLAN.md:373) permits the appcast URL but not release DMG URLs or their redirects; rule 1 also omits Polar deactivation despite requiring it later. If SDKs bypass the factory, the claimed policy is unenforced instead.  
    **Fix:** Enumerate license operations, update assets, redirects, and auxiliary resources, then prove each SDK actually uses the enforced transport.

28. **P2 — The live gate does not require the graded release checklist.** [S1-16](/Users/akshay/Sites/reader-app/PLAN.md:351) repeats the acceptance table, which omits `forbidden_hits`, One-line keyword checks, and the release checklist’s version/changelog requirements; automatic deployment occurs on every main push. “Mandatory before release” therefore has no single operational meaning.  
    **Fix:** Define which deployments are releases and make one shared release-check command the dependency of publishing and the live gate.

VERDICT: REVISE

### Claude's response to Round 2 (MAX_ROUNDS=2 reached without APPROVED — no fake convergence)

Accepted 13 of 14; one partial (kept for Akshay's tie-break). PLAN.md rewritten as v3.

- 12 Bench rule impossible → **accepted.** Row-validity rule: rows commit on top; valid for HEAD when the diff excluding `bench/results.csv` and `bench/baselines.json` is empty. `bootstrap` label exempts S0-* / S1-00..S1-03 until S1-13 merges. Self-tests added.
- 4 Text in URLs → **accepted.** Exact file-URL allowlist from `spec/network.json`, no query strings except recorded redirect params, same-origin restricted to the Vite manifest + `public/`, canary forms (plain, URL-encoded, base64, hex) checked in URL + headers + body. Mac: payload-level `mitmproxy` capture on the clean test account in S2-14; `NetworkPolicy` covers our code and its limits are stated.
- 7 Coverage ≠ untruncated → **accepted.** Pre-synthesis phoneme assertion on every call; S1-00 defines the limit measurement (duration plateau); duration-additivity check on doc `020`; `tts_overlimit` counter must be 0.
- 10 Graded gate only Short → **accepted.** 6 docs × 3 levels (incl. relational/negation `005` and multi-chunk `025`), grader gets the full source; inside `release-check.sh`, rerun on any model/prompt/chunking/grounding change.
- 13 Fallback over budget → **accepted.** Budget revised to 700 MB with the arithmetic (C12); locked configs: default 562 MB, fallback A 575 MB (Qwen2.5-0.5B), fallback B 662 MB (Qwen3-0.6B), low-end tier 365 MB (SmolLM2-360M); fp32 voice out of the default path.
- 16 `countTokens` cycle → **accepted.** New packet S1-03a (tokenizer) after S1-00; S1-03 and S1-05 depend on it. S0-03's CPU proof names `--dtype q4 --device cpu` (`model_q4.onnx`, 551 MB, has CPU kernels).
- 21 One schema contradiction → **accepted.** `RunStats` (strict, persisted) + `BugReport` envelope (bounded env strings, structured events, `user_description` never persisted) + `Event` schema (C11).
- 27 Corpus impossible → **accepted.** `spec/eval/manifest.json` fixes ids, categories, ranges, roles; bat article = `011` (medium); unpunctuated = `020`; relational = `005`; graded set named.
- 6 Clipboard ownership → **partially accepted.** Restore removed (ownership unprovable; Codex is right). The opt-in, no-restore fallback stays with the first line shown. *Rejected for now:* removing the feature entirely. **Tie-break handed to Akshay** (C9, Risks). If he sides with Codex, delete the setting and the ⌘C path from S2-06; nothing else changes.
- 5 Unconditional privacy claim → **accepted.** Goal and rule 1 qualified; PRIVACY.md generated from `network.json` and names the exception.
- 11 Sentence-initial invented names → **accepted.** Grounding v3: name candidates decided independently of the source via an embedded top-5,000 common-word list + stoplist; "Carol paid Bob" fixture cuts.
- 19 Long-doc limits / One-line policy → **accepted.** 100-chunk input limit with a message; cut one-liners dropped; > 50 % cut → fall back to Short with a message; reduce grounded against surviving one-liners.
- 25 Network policy gaps → **accepted.** `spec/network.json` enumerates Polar ×3, appcast, release assets + `objects.githubusercontent.com`, Hub URLs + redirect hosts; SDK bypass acknowledged and covered by the proxy audit.
- 28 Live gate vs release → **accepted.** Rule 10: a release is a tag; dev Space on every push, public Space on tags only; one `scripts/release-check.sh` is the dependency of `release.yml` and of S1-16.

**Unresolved for Akshay:** only #6 (clipboard fallback keep-opt-in vs remove). Everything else is folded in.

## Fable fresh-eyes pass (read-only subagent, no conversation context; reviewed v3)

Verdict: **SHIP-WITH-FIXES**. 22 findings (7 P1, 13 P2, 2 P3) and a third option for the clipboard tie-break. Findings verbatim:

1. P1 — Thursday's gate (S1-00) is not executable by the model it's assigned to: `codex-build` excludes secrets/browser work; S1-00 needs an HF token, Space creation, a deploy, a headed WebGPU run; `hf` CLI not installed; the Playwright project it proves against is created later by S1-01. Fix: split S1-00a (Codex, local, own config, `vite preview`) / S1-00b (Claude + Akshay); move the token step to S0-01.
2. P1 — Web releases will silently kill Mac auto-updates: one `v*` namespace + `releases/latest/download/appcast.xml` → the first web-only tag after a Mac release 404s every update check. Fix: separate prefixes or a fixed appcast URL.
3. P1 — The page auto-downloads 470 MB on load without asking (probe = load + generate). Fix: adapter/device probe only at load; download on explicit action with size shown; honor `saveData`.
4. P1 — `release-check.sh v0.1.0` cannot pass: rows are committed on PR branches, so after merge main HEAD's diff from `row.commit` includes every other PR; squash makes it worse; merge method unspecified. Fix: bench main HEAD → rows commit → tag that commit; merge commits only.
5. P1 — Zero slack by arithmetic: 7 dependency edges × 12 h merge cadence = Sunday evening before any packet takes time. Fix: cut order (S1-13/10/11 → NICE + extended bootstrap; Safari untested; graded pass on 3 docs; merge on demand for critical-path PRs).
6. P1 — `wasm-ci` has no LLM, yet dial/loading/privacy MUST proofs on `wasm-ci` require one; no fake worker specified. Fix: `?llm=fake` deterministic worker honoring abort; CI routes fetches to fixtures.
7. P1 — Referenced paths don't exist: the codex review hook (claimed absent), `~/.claude/skills/caveman`, `gitleaks`, `mitmproxy`. Fix: create/point/install with proofs.
8. P2 — Contradicting proofs: S1-03's "every fixture ≥ 8" vs `tokens.json` = 5; Mac can't reproduce web token counts; S0-03 done-when needs doc 025 without a chunker. Fix: named fixtures; per-target token fixtures; `--max-words 1000` on 005 + 011.
9. P2 — S1-04 and S1-05 are parallel Codex packets sharing unowned `loader.ts`/`net.ts`. Fix: move both into S1-03a as an owned interface.
10. P2 — Every panel message is text-only for users whose problem is text. Fix: every message spoken; "Speak messages" default on.
11. P2 — All-cut fallback auto-reads a 1,200-word chunk: "reading me too much". Fix: speak the notice, offer "Read this part".
12. P2 — No speech-rate control. Fix: 0.7–1.5 slider, persisted.
13. P2 — Dial change = 4–8 s of dead air. Fix: spoken notice instantly; speculative adjacent-level generation when idle.
14. P2 — Canned demo covers one level, so the dial is invisible on every no-WebGPU machine. Fix: pre-generate all four levels for doc 011.
15. P2 — Onboarding asks for Accessibility before one success. Fix: just-in-time; first run uses the clipboard hotkey.
16. P2 — Read all never shows the sentence being spoken. Fix: current sentence large + next dimmed.
17. P2 — Brand carve-out unenforced at file level; Stage 1 Pip is AI art; DCO without CLA means "Akshay owns the code" ends at the first outside PR. Fix: `brand/` with its own LICENSE + exception line; treat the placeholder as unprotected; state the ownership consequence.
18. P2 — License lock on launch-time validation punishes firewall users; source is public so a lock buys nothing. Fix: validate at activation and weekly at most; nag, never lock.
19. P2 — All product copy written by a Sonnet packet with no Voice Bank pass before 9/29. Fix: S1-L0 product copy (Claude) owning the strings.
20. P2 — Static-Space realities: (a) a CSP `connect-src` from `network.json` enforces the allowlist in every visitor's browser; (b) no COOP/COEP → no `SharedArrayBuffer` → single-threaded WASM, likely RTF < 1. Fix: generate the CSP; ship `coi-serviceworker` and assert `crossOriginIsolated`.
21. P3 — Bench identity too fine (OS/browser point versions fail every PR); web `machine_id` meaningless; `HEAD` on Hub files returns 302; `/triage` doesn't exist; grounding cuts "5%" vs "five percent". Fix: major versions + `baseline-reset`; `machine_id="web"`; `curl -sIL`; create the command; normalize spelled-out numbers on the source side.
22. P3 — No demo-day runbook (venue wifi vs 562 MB cold, cache eviction, no offline path). Fix: `docs/launch/demo-day.md` + `?models=local`, rehearsed Sep 30.

Tie-break opinion: ship v1 **without** automatic ⌘C; instead **arm-and-watch** — when AX yields nothing, say and speak "Press ⌘C", watch `changeCount` for ~5 s, run if it advances. The user performed the copy, so ownership is theirs by construction; no synthetic events, no privacy asterisk, ~90 % of the convenience. Automatic ⌘C to the roadmap only if the intake matrix shows arm-and-watch is insufficient.

### Claude's response to the Fable pass

Verified the environment claims myself before acting (memory rule: peer-session claims are unverified):
- Hook: **Fable was wrong.** The codex review gate exists in `~/.claude/settings.json` (lines 13/25 → `~/Sites/crossreview/hooks/codex-gate.sh pre|post`, matcher `Bash`). Nuance kept: it only fires from Claude Code sessions, so rule 5 now says PRs are opened and merged from Claude Code sessions.
- `~/.claude/skills/caveman`: absent, register is `~/.claude/output-styles/caveman-lite.md` — **Fable right**; S0-03 now cites the right file.
- `hf`, `gitleaks`, `mitmproxy`: **all missing** — Fable right; install steps + proofs added to S0-01, S0-02, S2-00.
- `codex-build` exclusions (secrets, browser, MCP): **Fable right**; S1-00 split into S1-00a (Codex, local) and S1-00b (Claude + Akshay, deployed); C8 states the rule.

Accepted 21 of 22 in full, 1 in part. PLAN.md rewritten as v4.
- 1, 2, 3, 4, 5, 6 → accepted (S1-00a/b; `web-v*`/`mac-v*` + fixed `gh-pages` appcast URL, C13; rule 11 no-unasked-download + two-stage probe, C14; release rows on `main` HEAD + merge-commits-only, rule 10 and S1-16; cut list + merge-on-demand for the critical path; `?llm=fake` named in every `wasm-ci` spec, C5).
- 7 → accepted except the hook claim (see above).
- 8, 9 → accepted (named fixtures; `tokens.web.json` / `tokens.mac.json`; S0-03 proof on 011 with `--max-words 1000`; `loader.ts` + `net.ts` moved into S1-03a, now Codex-tagged and on the critical path Friday morning).
- 10, 11, 12, 14, 15, 16 → accepted (spoken messages, rule 8; all-cut offers "Read this part", rule 2 and C6; rate slider MUST, C4; four-level canned demo; just-in-time permissions, C15; Read-all large-sentence view).
- 13 → **partially accepted.** Spoken dial notice ≤ 500 ms is MUST (new acceptance row). Speculative adjacent-level pre-generation is NICE: it doubles GPU work on a 0.8B model for a demo-moment gain, and the spoken notice already removes the dead air. Revisit after 9/29 with bench numbers.
- 17 → accepted (`brand/` with its own LICENSE + exception paragraph in the root LICENSE; the placeholder Pip is explicitly unprotected art, name-only protection until the illustrator; Q1 states the DCO ownership consequence and why it's acceptable).
- 18 → accepted (validate at activation, then weekly at most; nag, never lock; PRIVACY states cadence; Q2 updated; S2-11 tests changed).
- 19 → accepted (S1-L0 product copy, Claude, Sunday; `spec/strings/en.json` is the only string source; `strings-check` in `release-check.sh`).
- 20 → accepted (CSP `connect-src` generated from `network.json`, asserted by a browser-blocked fetch; `coi-serviceworker` with `crossOriginIsolated` asserted in S1-00a; WASM floors restated if it fails).
- 21, 22 → accepted (major-version identity + `baseline-reset`; `machine_id="web"`; `curl -sIL`; `.claude/commands/triage.md` in S0-02; spelled-out numbers normalized on both sides; S1-L4 demo-day runbook + `?models=local`, rehearsed Sep 30).
- Tie-break → **adopted arm-and-watch as Claude's recommendation** (C9, S2-06). The choice is still Akshay's: (a) arm-and-watch, (b) opt-in automatic ⌘C without restore, (c) hotkey only. S2-06 says what changes under each.

**Status:** Codex ended at REVISE after MAX_ROUNDS=2 (not a fake convergence; every round-2 point was folded in except the clipboard tie-break, which Fable then resolved with a third option). Fable: SHIP-WITH-FIXES, fixes applied. Awaiting Akshay's sign-off on v4 before any build.
