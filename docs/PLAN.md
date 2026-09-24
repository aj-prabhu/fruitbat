# Plan: Fruitbat — select text, get the short version, hear it

_Locked via claudex-loop — Claude (Fable 5.1) + Akshay Prabhu, 2026-09-23. MAX_ROUNDS=2. **v4** after Codex rounds 1–2 (cap reached at REVISE) and a Fable fresh-eyes pass (SHIP-WITH-FIXES). Full argument in `PLAN-REVIEW-LOG.md`. Awaiting Akshay's sign-off; no code before it._
_Working folder: `~/Sites/reader-app` (rename to `~/Sites/fruitbat` in S0-01). Research: `docs/research/2026-09-23-competitors-claudex-research.md`._

---

## Goal

A tool for people with low reading bandwidth (dyslexia first, everyone else second). Highlight text, press a hotkey, and a small panel shows TLDR bullets that are read aloud as they appear. A compression dial goes from "read every word" to "one line". Everything runs on the user's own machine with free open models. Nothing the user reads leaves the device.

Three jobs, in priority order:
1. Akshay uses it daily.
2. A public Hugging Face Space live by **2026-09-29**, submitted to the Open Together community-demo slot by **2026-10-02 11:59 PM PT** (36 slots, event 2026-10-16 at The Midway, SF).
3. An open-source (AGPL-3.0) Mac menu-bar app. Public flagship on github.com/aj-prabhu. **Monetization ($29 lifetime for the signed build) is designed but deferred: build a working product first, then decide** (Akshay, 2026-09-23).

Stage 1 = static Space, all inference in the visitor's browser. Stage 2 = native macOS menu-bar app. Same spec folder feeds both.

---

## Non-negotiables (every packet obeys these)

1. **Text never leaves the device.** No telemetry. The complete list of outbound traffic: (a) `GET` of pinned model files from the Hugging Face Hub, exact file URLs from `spec/models.json` plus the redirect hosts recorded in S1-00b / S2-03a; (b) a bug report the user previews and opens themselves; (c) Mac only: Polar license `activate` / `validate` / `deactivate` (validate at most weekly); (d) Mac only: Sparkle's appcast check and release-asset download, disclosed in onboarding and switchable off. The web page also ships a Content-Security-Policy `connect-src` generated from `spec/network.json`, so the allowlist is enforced in every visitor's browser, not just in our test. The Mac app never posts synthetic keystrokes and never writes the clipboard (see Intake). Logs are structured (numbers + enums) and never contain source text, bullets, audio, file names, or URLs of what the user was reading. Tests prove it (S1-11, S1-12, S2-10, S2-14). Third-party SDK traffic (Sparkle, MLX downloader) is verified by a proxy capture in S2-14.
2. **"Read all" is always one key away**, and it reads *all* of it: every synthesis call is checked against the voice model's token limit before it runs, and the long-input fixture's audio duration is checked for additivity (S1-04). If every bullet of a chunk fails grounding, the panel **says and speaks** "Couldn't make a summary I trust for this part" and offers **Read this part** as one key; it never auto-plays a whole chunk the user didn't ask for.
3. **No merge without a bench run.** Rows are committed in the PR in a separate commit on top of the tested commit. A row is valid for HEAD when `git diff --quiet <row.commit> HEAD -- . ':!bench/results.csv' ':!bench/baselines.json'` is empty. CI's `bench-gate` finds such rows and runs `bench/gate.py` against approved baselines. **Merge commits only, never squash** (squash would invalidate every row). **Bootstrap exemption**: PRs for S0-01..S0-06, S1-00a/b, S1-01, S1-02, S1-03a, S1-03 carry the `bootstrap` label and pass `bench-gate` with a "runner not yet available" note; the label is retired when S1-13 merges (or, if the cut list in Approach is used, when `web-v0.1.0` is tagged).
4. **Models and runtimes are pinned**: repo id + revision hash for every model file and voice, exact npm/SwiftPM versions for every inference library, in `spec/models.json` and lockfiles. The privacy test asserts every model URL is one of the exact expected file URLs.
5. **Akshay approves every merge.** Agents open PRs. Nobody auto-merges. The `codex review` gate is a Claude Code hook (`~/.claude/settings.json` → `~/Sites/crossreview/hooks/codex-gate.sh`, matcher `Bash`): it fires when `gh pr create` / `gh pr merge` run **from a Claude Code session**, and blocks the merge on open P1/P2. So PRs are opened and merged from Claude Code sessions, never from a plain terminal. Critical-path PRs (see Approach) are merged on demand when he is pinged; everything else in two daily batches (noon, evening).
6. **One branch per packet**, named `pkt/<ID>-<slug>`. PR title starts with the packet ID. Every packet's `Proof` must fail on a missing or empty artifact.
7. **Shared spec is the source of truth** for dial levels, prompts, chunking, grounding, schemas, and the eval corpus. Web and Mac both load it. Neither hard-codes a prompt.
8. **Human-facing text** (post, application, note to the illustrator, product copy, onboarding copy, error messages, panel labels, loading lines) goes through the Voice Bank protocol, in packet S1-L0 (Claude), not inside a Sonnet UI packet. **Every panel message is also spoken** (same voice, short), setting "Speak messages" default on, both targets: a silent error is a wall for the audience this is for.
9. **Walking skeleton first.** No UI, brand, or stats packet merges before S1-00a/b prove real text → real summary → real audio locally and on the deployed dev Space with the pinned runtime (due Thu 9/24 end of day).
10. **A release is a tag, and web and Mac have separate tag namespaces.** `web-v*` publishes the public Space `2shay/fruitbat`; `mac-v*` publishes a GitHub Release + appcast. Every push to `main` deploys to the dev Space `2shay/fruitbat-dev`. The Sparkle appcast lives at a **fixed URL** (`https://aj-prabhu.github.io/fruitbat/appcast.xml`, `gh-pages` branch updated by `release.sh`), never at `releases/latest/…`, so a web tag can never break Mac updates. One command, `scripts/release-check.sh <commit>`, is the dependency of every release and of the live gate. **Release rows:** freeze `main` → `bench/run.sh` on `main` HEAD → commit the rows → `release-check.sh` → tag **the rows commit**.
11. **Nothing big downloads without asking.** On page load only the WebGPU adapter/device probe runs (milliseconds). The voice model (92 MB) loads automatically except when `navigator.connection.saveData` is on or the device is mobile. The summarizer (~470 MB) downloads only on the first summary request or an explicit "Load summarizer (470 MB)" button, with the size shown first. The canned demo needs no download at all.

---

## Approach (calendar, with the critical path and the cut list)

| Date | What | Gate |
|---|---|---|
| Wed 9/23 | Plan locked. Codex rounds 1–2. Fable pass. Akshay sign-off. | |
| Thu 9/24 | Stage 0 (repo, house rules, corpus, schemas). **S1-00a local skeleton + S1-00b deployed to the dev Space by EOD.** | Real summary spoken from the dev Space URL, ugly. |
| Fri 9/25 | S1-03a (tokenizer + loader + net), then S1-02..05 in parallel. | Bake-off ADR written. |
| Sat 9/26 | S1-06 integration; S1-07 panel; S1-09 loading UX. **Scope cutoff Sat 9/26 EOD.** | Dial, Esc, TTFA measured. |
| Sun 9/27 | S1-L0 product copy; S1-10..13 (stats, bug button, privacy test, bench). S1-08 Pip if time. | Privacy test green on WebGPU. |
| Mon 9/28 | S1-14 browser matrix + fixes. Graded pass. Application draft. | Chrome + Safari pass. |
| Tue 9/29 | **Live gate S1-16**: release rows, `release-check`, tag `web-v0.1.0`, public Space. | Numbers in the gate file. |
| Wed 9/30 – Thu 10/1 | Buffer. Demo-day rehearsal (S1-L4). Small post. Submit application (target Oct 1, hard stop Oct 2 11:59 PM PT). | Confirmation screenshot. |
| Oct 1 → Oct 3 | **S2-03a Mac engine spike** (MLX LLM + Kokoro via CLI). Decision Oct 3: native or safety net. | Spike gate. |
| Oct 3 → Oct 15 | Stage 2 core (engine, intake, panel, permissions). Demo both at the event Oct 16. | |
| Oct 16 → ~Oct 30 | Mac QA, updates, landing page, big post. **Stage 2b (only if he decides to monetize): payments, license, notarized paid build.** | Release checklist. |

**Critical path for 9/29** (merged on demand, not on the batch clock): S0-01 → S1-00a → S1-00b → S1-03a → S1-04 ∥ S1-05 → S1-06 → S1-09 ∥ S1-12 → S1-14 → S1-16. That is 8 edges; with three day-long Codex packets in the middle there is **no slack**. Merge on demand is what makes it possible at all.

**MUST for 9/29**: S0-01..05, S1-00a/b, S1-01, S1-03a, S1-02 (selection + paste), S1-03, S1-04, S1-05, S1-06, S1-07 (basic), S1-09, S1-L0, S1-10 (store only), S1-11, S1-12, S1-13, S1-14 (Chrome + Safari), S1-15, S1-16.
**NICE**: S1-08 Pip animation (static Pip SVG is MUST), PDF drop, share, save audio, panel position setting, Stats view, voice picker beyond 2 voices, speculative dial pre-generation, S0-06 health workflow.

**Cut list if it slips, in order:** (1) S1-13, S1-10, S1-11 → NICE; extend the `bootstrap` label through `web-v0.1.0` and let `release-check.sh` accept a hand-filled gate file in place of bench rows; (2) S1-14 Safari → "untested" cell with a UI note; (3) bake-off on 2 candidates (default + fallback A) and the graded pass on 3 docs for `web-v0.1.0`, the rest in the buffer; (4) S1-07 ships with the dial, bullets, highlight, stop, rate; every other control moves to NICE.

Stage 2 packets S2-00..S2-02 can start any time; they don't touch the web lane.

---

## Architecture

### Repo layout (`aj-prabhu/fruitbat`, public from the first commit)

```
README.md  LICENSE (AGPL-3.0, with a brand-exception line)  PRIVACY.md  SECURITY.md  CONTRIBUTING.md (DCO; merge commits only)  AGENTS.md  CLAUDE.md -> AGENTS.md  CHANGELOG.md
brand/                     # LICENSE (all rights reserved) + BRAND.md + the illustrator's art when it lands; forks must rename and redraw
spec/                      # shared, language-neutral, loaded by web and mac
  dial.json  dial.schema.json
  prompts/short.md  caveman.md  oneline.md  reduce-oneline.md
  chunking.md              # token budgets, TTS-safe splitting, caps, input limits
  grounding.md             # the number/name check, v3
  models.json              # pinned ids + revision hashes + exact file URLs + sizes + library versions, per target
  network.json             # every allowed outbound URL pattern, per target (source for tests, CSP, NetworkPolicy, PRIVACY.md)
  schemas/run-stats.schema.json  bug-report.schema.json  event.schema.json
  strings/en.json          # every user-facing string (S1-L0 owns it; web and mac load it)
  version.json  license.json (Polar organization_id, benefit_id)
  fixtures/                # JSON fixtures shared by web (Vitest) and mac (XCTest); tokens.web.json / tokens.mac.json per target
  eval/manifest.json  eval/corpus/  eval/rubric.md  eval/grade.md  eval/validate.py
web/                       # Stage 1 — Vite + TypeScript + Preact, static output
  index.html  src/  src/workers/  public/demo/  public/models/kokoro-voices/  public/coi-serviceworker.js  README.md (HF Space front matter)
mac/                       # Stage 2 — SwiftPM package + Xcode app target
  Package.swift  Sources/FruitbatCore  Sources/fruitbat-cli  App/FruitbatApp
bench/                     # run.sh, web/, mac/, gate.py, score.py, baselines.json, results.csv, graded/, README.md
scripts/                   # deploy-space.sh, release-check.sh, release.sh, check-logs.sh, check-network.sh, privacy-md.mjs, csp.mjs
.github/workflows/         # ci.yml, space-dev.yml (main → dev Space), release.yml (web-v* → public Space; mac-v* → Release + appcast), health.yml
.github/ISSUE_TEMPLATE/bug.yml  PULL_REQUEST_TEMPLATE.md
.claude/commands/triage.md # the /triage command the bug pipeline names
docs/                      # research/, adr/, qa/, launch/, PLAN.md, PLAN-REVIEW-LOG.md
```

### Pipeline (same shape on both targets)

```
intake ─► normalize ─► sentences ─► TTS-safe segments (token-checked, source offsets kept) ─► chunks (token-budgeted, sentence-aligned)
   │
   ├─ level "Read all": segments ─► TTS worker ─► bounded PCM queue ─► play; panel shows the current sentence large, next one dimmed
   │
   └─ levels Short / Caveman / One line:
        LLM worker: for each chunk → prompt[level] → token stream → bullet parser → grounding v3
        ─► bullet shown + pushed to TTS worker ─► bounded PCM queue ─► play + highlight
        One line on > 1 chunk: per-chunk one-liners → reduce (groups ≤ 10, depth ≤ 2) → the one line (only this is spoken)
```

- **Concurrency model (web).** Three actors: main thread (UI, `AudioContext` playback, hotkeys), LLM worker, TTS worker. `gen: idle | loading | running | done | failed` and `play: idle | playing | paused | stopped` are independent. Bounded queues: ≤ 3 TTS requests in flight, ≤ 30 s of PCM. Esc is handled on the main thread and never waits on a worker.
- **Cancellation.** Monotonic `runId` on every message; stale results dropped; dial change / stop / new input bump it, abort the LLM (`AbortController`), drop queued TTS work, stop playback ≤ 200 ms. Playback cursor and generation cursor are separate; "current chunk" = the chunk containing the playback cursor.
- **Dial change never goes silent.** The instant the dial moves, the panel speaks a one-liner from `strings/en.json` ("Making it shorter." / "Adding detail.") while the current chunk regenerates. NICE: when generation is ahead of playback, pre-generate the adjacent levels for the current chunk so the dial is near-instant.
- **TTS-safe segments and the truncation proof.** S1-00a measures the kokoro-js limit (growing phoneme counts; the point where audio duration stops growing); the TTS worker phonemizes and asserts `≤ limit` before **every** synthesis call (over-limit = split further; violations counted as `tts_overlimit`, must be 0); the coverage test asserts offsets tile the source **and** duration additivity on doc `020` within 10 %.
- **Chunking (`spec/chunking.md`).** Token budgets from the pinned tokenizer (S1-03a): chunk ≤ 1,600 input tokens, 256 reserved for output; sentence-aligned; oversized sentences split by the TTS-safe rule; docs ≤ 1,600 tokens are one chunk; per-chunk bullet caps. **Input limit:** 100 chunks (≈ 120,000 words); beyond that: "This is over 120,000 words. Select a part of it." (shown and spoken). One-line reduction groups ≤ 10, depth ≤ 2.
- **One-line policy on failures.** A cut one-liner contributes nothing and is counted; the final line comes from survivors; if more than half the chunks are cut, One line fails → Short, with "Couldn't boil this down to one line I trust. Here's the short version." The reduce step is grounded against the surviving one-liners.
- **Grounding v3 (`spec/grounding.md`).** A bullet passes if (a) every number in it appears in its source, with numbers normalized on **both** sides (`1,000`=`1000`, `50%`=`50`, `$5`=`5`, spelled-out numbers ≤ 100 converted, e.g. "five percent" = 5), and (b) every *name candidate* appears in its source. Name candidate = a capitalized token that is not sentence-initial, or is sentence-initial and not in the embedded common-word list (top 5,000 English words) and not in the stoplist (`The, A, An, It, They, This, These, That, We, He, She, I, You, Here, There, Then`). "Carol paid Bob $5" vs "Alice paid Bob $5" is cut; "They feed at night" vs "Bats feed at night" passes. Cut bullets are never spoken. All-cut → rule 2 behavior. Grounding is a **filter for the worst errors, not a truth guarantee**.
- **Thinking off.** `enable_thinking: false` via the chat template kwarg (or `/no_think`). Test: no `<think>`, ≥ 1 valid bullet.

### Stage 1 — Web (static Spaces `2shay/fruitbat-dev` and `2shay/fruitbat`)

- Vite + TypeScript + Preact. No backend. **Runtime pinned in S1-00a**: `@huggingface/transformers` **4.x** at the exact version the spike proves, and a `kokoro-js` version resolving to the same transformers major (else vendor its small loader with the Apache-2.0 notice). `pdfjs-dist` for PDF drop (NICE). Atkinson Hyperlegible self-hosted.
- **Pinning.** `env.remotePathTemplate = "{model}/resolve/<sha>/"` per model; the offered voice files vendored into `web/public/models/kokoro-voices/` at a pinned commit. `spec/network.json` lists every exact expected file URL and the redirect hosts observed in S1-00b; the privacy test and the generated CSP allow nothing else.
- **Cross-origin isolation.** Static Spaces cannot set COOP/COEP headers, and without them there is no `SharedArrayBuffer`, so onnxruntime's WASM path is single-threaded and probably slower than real time. S1-00a ships `coi-serviceworker` and asserts `crossOriginIsolated === true` on the dev Space; if that cannot be made to hold, the WASM floors in the acceptance table are restated honestly before S1-04 merges.
- **Locked configurations under the cold budget (≤ 700 MB).** Voice: Kokoro `q8` on WASM (92 MB) default; `q8f16` on WebGPU (86 MB) tried in the bake-off; `fp32` out. Summarizer, with the voice included: **default** `onnx-community/Qwen3.5-0.8B-Text-ONNX` q4f16 (470 → 562 MB); **fallback A** `onnx-community/Qwen2.5-0.5B-Instruct` q4f16 (483 → 575 MB); **fallback B** `onnx-community/Qwen3-0.6B-ONNX` q4f16 (570 → 662 MB); **low-end tier** `HuggingFaceTB/SmolLM2-360M-Instruct` q4f16 (273 → 365 MB). `Qwen3.5-2B` is out of v1.
- **Two-stage probe.** On load: `navigator.gpu` → adapter → device only. After the summarizer downloads (rule 11): generate 1 token; any failure (missing feature, device lost, allocation, invalid output) → `llm: failed`, summarization disabled with a spoken note, Read all still works. Failure injection via `?inject=nogpu|devicelost|oom`.
- **Fake LLM for CI.** `?llm=fake` selects a scripted worker (deterministic bullets per doc from a fixture, configurable delay, honors `AbortController`); CI routes model fetches to small fixtures. Every `wasm-ci` spec that needs summarization names it. q4f16 needs WebGPU; no WebGPU → Read all only; mobile Safari = same.
- **Loading UX:** rule 11; per-model progress with MB; cache detection; canned demo = **all four levels** of doc `011` pre-generated (bullets + audio), labeled as a recording, so the dial works on the sample article on every device including phones and no-WebGPU laptops; "Try it now" makes sound in < 1 s.
- **Intake:** the sample article on the page (select → "Read" chip, or `⌥R`), a paste box, (NICE) drop zone. No URL fetch.
- **Panel:** bottom-right; (NICE) position setting. Pip peeks over the top edge (static SVG for 9/29). Bullets appear as spoken, current segment highlighted; for Read all the current sentence is shown large with the next dimmed. **Speech rate slider 0.7–1.5, persisted** (MUST). Dark mode. Font size and spacing. All strings from `spec/strings/en.json`.
- **Stats store:** `RunStats` rows only, localStorage, retention 200, quota errors caught. Stats view NICE.
- **Bug button:** `BugReport` envelope → preview → GitHub issue form via field params → user submits. Copy fallback. `user_description` never persisted.

### Stage 1 acceptance table (S1-05 bake-off AND S1-16 live gate; M1 Pro, Chrome, ≥ 100 Mbps)

| Measure | Definition | Must |
|---|---|---|
| Cold download budget | voice + LLM + voices, bytes, from `models.json`, verified by the privacy request log | ≤ 700 MB |
| Cold time to first summary audio | from the first summary request on an empty cache (download included), 1,000-word doc, Short | ≤ 90 s |
| Warm TTFA, Read all | trigger → first audio sample plays | ≤ 3 s |
| Warm TTFA, Short | trigger → first audio sample plays, 1,000-word doc | ≤ 8 s |
| Dial-change silence | dial move → spoken notice starts | ≤ 500 ms |
| Decode rate | tok/s, LLM worker | ≥ 15 |
| Faithfulness, diagnostic | `facts_token_hit` median over the graded docs | ≥ 90 % Short, ≥ 75 % Caveman, ≥ 60 % One line |
| Hallucinated numbers / forbidden claims | `halluc_flags`, `forbidden_hits` | 0 / 0 |
| One-line keywords | `oneline_keyword_hit` | ≥ 80 % |
| Faithfulness, graded | rubric on graded docs × 3 levels, grader given the full source | ≥ 4 / 5 on every level |
| Cut rate at Short | grounding drops / bullets | ≤ 10 % |
| Stop latency | Esc → silence | ≤ 200 ms |
| Read-all coverage | offsets tile the source; duration additivity on `020` within 10 %; `tts_overlimit` | 100 % / pass / 0 |
| Cross-origin isolation | `crossOriginIsolated` on the dev Space | true, or WASM floors restated |

### Stage 2 — Mac (SwiftPM package + menu-bar app)

- **macOS 14+, Apple Silicon only** on the native path. Swift 6.4 present; Xcode 26 required (S2-00).
- **`FruitbatCore`**, **`fruitbat-cli`**, **`FruitbatApp`** as before (`MenuBarExtra`, `KeyboardShortcuts`, non-activating `NSPanel`, settings, onboarding, Stats, Sparkle 2, Polar + trial). `NetworkPolicy` = the `URLSession` factory our code uses, allowlist from `spec/network.json`.
- **LLM:** `mlx-swift-lm`; one `ChatSession` per chunk/reduction; contamination test; `mlx-community/Qwen3.5-2B-4bit` if it exists at S2-03a, else `Qwen3-1.7B-4bit`; pinned.
- **TTS:** `mlx-audio-swift` Kokoro (`mlx-community/Kokoro-82M-bf16`) pinned; G2P asset inventory + warm offline test in S2-03a; eSpeak NG (GPL-3.0) compatible with AGPL-3.0 (ADR 0002); fallback `sherpa-onnx`.
- **Decision gate S2-03a (Oct 1–3):** native proven, or the WKWebView safety net with a **macOS 26 floor** via ADR 0003 and its own packets.
- **Intake (privacy-first, no synthetic keystrokes):** (1) Accessibility API `kAXSelectedTextAttribute` — the automatic path once Accessibility is granted; (2) `⌃⌥V` summarizes the clipboard, zero permissions; (3) region OCR via the region picker → `ScreenCaptureKit` → Vision; whole screen = picker preselected; (4) **arm-and-watch** when AX yields nothing: the panel shows and speaks "Press ⌘C to read it", arms a clipboard watcher for 5 s, and runs if `changeCount` advances — the user performed the copy, so ownership is theirs by construction; the app never posts ⌘C and never writes the clipboard. Automatic ⌘C is on the roadmap only if the intake matrix shows arm-and-watch is not enough. *(This is Claude's recommendation for the tie-break; see Risks.)*
- **Permissions, just in time.** First run needs **no** permission: the "try it" step uses `⌃⌥V` on text the user copies. After the first success, Accessibility is offered as "skip the ⌘C step"; Screen Recording is asked the first time the user presses the region hotkey. Each prompt is one plain sentence, opens the right pane, and says what still works if denied. First OCR run warns that anything on screen, including passwords, becomes text locally.
- **Trial + license (Polar):** 7-day trial; then a key: `activate` once (`label` = hostname hash; store key + `activation.id` in Keychain), `validate` **at activation and at most weekly after** (`status == "granted"`, `benefit_id == spec/license.json.benefit_id`, `last_validated_at` persisted); if validation can't happen for 14 days the app **nags, never locks** — the source is public, a lock buys nothing against piracy and punishes exactly the firewall-using users the privacy brand attracts; "Sign out of this Mac" calls `deactivate`; PRIVACY.md states the cadence.
- **Updates + release:** Sparkle 2, appcast at the fixed `gh-pages` URL (rule 10), EdDSA private key in the 1Password Claude vault, update check disclosed and switchable off. `release.sh` (after `release-check.sh`): archive → sign with Developer ID + hardened runtime → notarize app zip → staple app → DMG → notarize DMG → staple DMG → sign appcast entry → GitHub Release (`mac-v*`) → push appcast to `gh-pages`. Proof includes a quarantined download opening cleanly on a second clean user account and a Sparkle update there.

---

## Key decisions & tradeoffs

| # | Decision | Why | Rejected |
|---|---|---|---|
| Q1 | **AGPL-3.0** for code with a brand exception line; `brand/` has its own all-rights-reserved LICENSE (name, Pip, logo; forks must rename and redraw). DCO, no CLA. **Note:** after the first outside contribution Akshay no longer solely owns the code, so dual-licensing or App Store distribution would need every contributor's consent; acceptable because neither is a goal. | Blocks closed clones and closed hosted forks of the Space. Vault standard. Paid build works under AGPL regardless of ownership. | MIT: a $5 clone the week the post lands. GPL-3: hosted fork can go closed. CLA: friction for a solo indie tool. |
| Q2 | **Free:** Space, build from source. **Paid:** signed Mac app, **$29 lifetime**, 7-day trial, no feature gating, validate weekly at most, nag-never-lock. **Polar.sh**. Apple Developer Program ($99/yr; break-even 4 sales). | VoiceInk-proven. $25–39 safe band. Polar handles tax and keys. Firewall users are the audience; a launch-time lock is HN bait. | $49. Lemon Squeezy/Gumroad. App Store. Launch-time lock. |
| Q3 | **Open model via MLX** on Mac (macOS 14+). Apple FM = roadmap. WKWebView safety net = macOS 26 floor via ADR. | Apple Intelligence is off on Akshay's own M1 Pro; Apple's model is closed and 4–8K context. | Apple-only. WebView-only. |
| Q4 | **Zero telemetry.** Local metrics, bench any agent runs, user-initiated bug reports. Opt-in stats = roadmap with consent rules fixed. | Privacy is the product. | Default-on telemetry. No measurement. |
| Q5 | **Pip the fruit bat.** Stage 1 Pip is a code-drawn placeholder **treated as unprotected art**; the name is what `brand/` protects until the illustrator's hand-inked art lands (with a written copyright handover). AI art never ships as the brand. | Bats read the world by sound. Cute sells to the HF crowd. AI art can't be copyrighted; pretending otherwise would empty the carve-out. | No character. A bat hanging from the cursor (clunky, per Akshay). |
| C1 | Names: **Fruitbat** / **Pip**. `aj-prabhu/fruitbat`, `2shay/fruitbat`, `fruitbat.io` free (2026-09-23). | Searchable, unique. | "Pip" as app name (Python's pip). |
| C2 | Hotkeys (Mac, rebindable): `⌃⌥R` selection, `⌃⌥⇧R` region/screen, `⌃⌥V` clipboard, `⌃⌥↑/↓` dial, `Esc` stop. Web: `⌥R`. | Rarely bound elsewhere. | `⌥⌘R`. |
| C3 | Dial labels **Read all · Short · Caveman · One line**. Default Short. Every level and every message spoken. | Plain words. | Cute labels. |
| C4 | Voice `af_heart`, **rate slider 0.7–1.5** persisted, 2 voices for 9/29. | Rate is the first thing every TTS user touches. | Fixed speed. |
| C5 | Vite + TS + Preact + Workers; Vitest + Playwright; `?llm=fake` for CI. Mac: SwiftPM + Xcode 26. | Well-known to cheaper models; Esc stays responsive; CI can't run WebGPU. | React. Tauri. Main-thread inference. Tests that "pass" without an LLM. |
| C6 | Grounding v3 = deterministic filter (numbers normalized both sides, common-word list), drop on fail, **offer** read-in-full. Token diagnostic gates regressions; graded rubric on all three levels gates releases. | Catches wrong numbers/names deterministically; can't catch reversed relations, so it is not the truth gate. Auto-reading a whole chunk is "reading me too much". | Citation tags. Token overlap as the only measure. Auto-read on all-cut. |
| C7 | Bug reports = GitHub issue form via field params, no server. | No secrets, no server, user sees everything. | Vercel relay. |
| C8 | Codex builds the Codex-tagged packets via `codex-build`; Claude reads every diff. Packets that need secrets, a browser session, or Akshay's accounts are **never** Codex-tagged (the skill excludes them). | Direction table + skill exclusions. | |
| C9 | Mac selection fallback = **arm-and-watch** (user presses ⌘C on request; app watches `changeCount` for 5 s). No synthetic keystrokes, no clipboard writes, no privacy asterisk. **Locked by Akshay 2026-09-23 (option a).** | Ownership by construction; covers ~90 % of the convenience; keeps rule 1 absolute. | Silent ⌘C (breaks rule 1). Restore-after-copy (can clobber another app's copy). |
| C10 | Prebuilt `dist` + README, `app_file: index.html`, no `app_build_command`. Dev Space on every `main` push; public Space on `web-v*` tags. | HF only serves. A release means a tag. | HF-side build. One Space on every push. |
| C11 | Two schemas: strict `RunStats` (persisted, benched) + `BugReport` envelope (never persisted). | One schema either broke reports or weakened the privacy rule. | |
| C12 | Cold budget 700 MB. | 90 s at 100 Mbps ≈ 750 MB after init; 700 keeps margin and admits two fallbacks. | 600 MB: one eligible model, no fallback. |
| C13 | Separate tag namespaces `web-v*` / `mac-v*`; appcast at a fixed `gh-pages` URL. | A web-only tag would otherwise make `releases/latest` a release with no appcast and break every Mac user's updates silently. | One `v*` namespace. |
| C14 | Nothing big downloads without asking (rule 11); canned demo covers all four levels. | Auto-pulling 470 MB on load is screenshot bait and a wall for slow links; judges on no-WebGPU machines must still see the dial. | Probe-by-downloading on load. One-level demo. |
| C15 | Permissions just in time; first run is permission-free. | Accessibility is the scariest macOS prompt; a first success before it doubles the grant rate. | Onboarding wall. |

---

## Toolchain

Nothing loads unless a packet names it.

| Where | Skill / tool | Used by |
|---|---|---|
| Claude bench | `impeccable` or `frontend-design` | S1-07 panel UI, S1-08 Pip, S2-L1 landing page |
| Claude bench | `codex-build` (excludes packets needing secrets, browser sessions, or MCP) | every packet tagged **Codex** |
| Claude bench | Playwright MCP (shared agent Chrome; never raise it) + `claude-in-chrome` | S1-00b, S1-14, S1-16 manual QA |
| Both benches | `mlx-swift-lm` agent skill (in `ml-explore/mlx-swift-lm/skills/mlx-swift-lm`) | S2-03a, S2-03, S2-05; installed in S2-00 with a load smoke test |
| Claude bench | Voice Bank protocol (`Voice Bank.md` + channel file); Caveman register = `~/.claude/output-styles/caveman-lite.md` | S1-L0..L4, S2-15, S2-L1; S0-03 prompts |
| Claude Code hook | `~/Sites/crossreview/hooks/codex-gate.sh` via `~/.claude/settings.json` (fires on `gh pr create` / `gh pr merge` run from a Claude Code session) | every PR |
| Test runners | Playwright's bundled Chromium (headed, clean profile) for e2e and bench; never the agent Chrome profile | S1-12, S1-13, S1-14 |
| CLI tools | `hf` **installed and logged in 2026-09-23** (`~/Library/Python/3.9/bin/hf`); `gitleaks` (`brew install gitleaks`, S0-02); `mitmproxy` (`brew install mitmproxy`, S2-00) | S1-00b, CI, S2-14 |

---

## Work packets

**Model tags.** `Haiku` = mechanical, fully specified, small blast radius. `Sonnet` = app code with a clear spec and a test to hit. `Codex` = gpt-6-astra via `codex-build`, for the parts where a wrong guess costs days: runtime compatibility, model loading, streaming audio, concurrency, macOS permissions, licensing, payments, release signing. `Claude` = voice work, judgment, or anything needing secrets / a browser session / Akshay. Every diff is read by Claude before the PR opens.

**Packet format.** Tag · MUST/NICE · Depends on (hard) · Parallel with · Files · Do · Done when · Proof (fails on a missing or empty artifact). Interfaces between parallel packets are named and owned.

### Stage 0 — Foundation (Thu 9/24)

**S0-01 · Repo bootstrap + accounts** — `Haiku` for files; `Claude` + Akshay for accounts · MUST · `bootstrap`
- Depends on: Akshay's sign-off. Parallel with: nothing (first).
- Files: `README.md`, `LICENSE` (AGPL-3.0 verbatim + a brand-exception paragraph), `brand/LICENSE`, `brand/BRAND.md`, `PRIVACY.md` (generated later; placeholder now), `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `.gitignore`, `.editorconfig`, `docs/` (research, plan, review log; the private brief stays in the vault), `spec/version.json`.
- Do: rename folder to `~/Sites/fruitbat`; **fresh history**: `rm -rf .git && git init && git add -A && git commit` (the local planning commits are never published: Build Standard says publish by fresh-history extraction); `gh repo create aj-prabhu/fruitbat --public --source . --push`; CONTRIBUTING: DCO, packet branches, row-validity rule, **merge commits only**, `bootstrap` label. **Done 2026-09-23:** HF write token `fruitbat-deploy` created, stored in the 1Password Claude vault and in the `hf` CLI (`~/Library/Python/3.9/bin/hf`, logged in as `2shay`). Remaining here: `gh secret set HF_TOKEN --repo aj-prabhu/fruitbat` (read the value with one `op` call).
- Proof: `gh repo view aj-prabhu/fruitbat --json isPrivate,licenseInfo` → public, `AGPL-3.0`; `grep -c "GNU AFFERO GENERAL PUBLIC LICENSE" LICENSE` = 1; `grep -ci "brand/" LICENSE` ≥ 1; `test -s brand/LICENSE`; `grep -c "merge commit" CONTRIBUTING.md` ≥ 1; `hf auth whoami` prints `2shay`; `gh secret list | grep -c HF_TOKEN` = 1.

**S0-02 · House rules + CI skeleton + triage command** — `Sonnet` · MUST · `bootstrap`
- Depends on: S0-01. Parallel with: S0-03, S0-04a, S0-05.
- Files: `AGENTS.md`, `CLAUDE.md` (symlink), `.github/PULL_REQUEST_TEMPLATE.md`, `scripts/check-logs.sh`, `scripts/check-network.sh`, `.github/workflows/ci.yml`, `.claude/commands/triage.md`.
- Do: the 11 non-negotiables with the command that enforces each; deps table; logger contract (`event.schema.json`); `check-logs.sh` and `check-network.sh` as before; CI jobs: lint, unit, `check-logs`, `check-network`, `gitleaks`, `wasm-ci` e2e, `bench-gate` (row-validity + `bootstrap` + `baseline-reset` labels); PR template: packet ID, rows or `bootstrap`, Voice Bank checkbox; `/triage` command: reproduce with corpus + CLI/bench, classify, ask one question or open `fix/<issue>-<slug>`. `brew install gitleaks`.
- Proof: throwaway PR with a planted `console.log("text")`, a planted `new WebSocket(...)`, and a planted fake AWS key → three red checks; remove → green; a `bootstrap`-labelled PR's `bench-gate` log contains `runner not yet available`; `test -s .claude/commands/triage.md`.

**S0-04a · Eval corpus + manifest** — `Haiku` · MUST · `bootstrap`
- As v3: `manifest.json` fixes ids `001–010` short, `011–020` medium, `021–030` long; roles `005` relational/negation, `011` bat article (Space sample), `020` unpunctuated (medium, no sentence-ending punctuation), `025` multi-chunk; graded set `{005, 011, 013, 020, 025, 028}`; 3 PDFs.
- Proof: `python3 spec/eval/validate.py --corpus-only` prints `30 docs OK, roles OK`.

**S0-03 · Shared spec: dial, prompts, chunking, grounding, models, network, strings skeleton** — `Codex` · MUST · `bootstrap`
- Depends on: S0-01, S0-04a. Parallel with: S0-02, S0-04b, S0-05.
- Files: `spec/dial.json`, `spec/dial.schema.json`, `spec/prompts/*.md`, `spec/chunking.md`, `spec/grounding.md` (+ `spec/common-words.txt`), `spec/models.json`, `spec/network.json`, `spec/strings/en.json` (keys only, placeholder values; S1-L0 fills them), `spec/tools/try-prompts.mjs` (Node + Transformers.js 4.x, `--dtype q4 --device cpu`, `--max-words 1000`).
- Do: levels as v3; Caveman register from **`~/.claude/output-styles/caveman-lite.md`**; chunking incl. input limit; grounding v3 with both-sides number normalization; prompts force `- ` lines; `models.json` with revision `sha`, exact file URLs, sizes, licenses; `network.json` per target (Hub URLs + redirect hosts placeholder filled by S1-00b, Polar ×3, appcast fixed URL, release assets + `objects.githubusercontent.com`).
- Done when: each prompt ≤ 120 words; every level yields ≥ 1 valid bullet on docs `005` and `011` (≤ 1,000 words each); no `<think>`; licenses recorded.
- Proof: `node spec/tools/try-prompts.mjs --model onnx-community/Qwen3.5-0.8B-Text-ONNX --dtype q4 --device cpu --doc spec/eval/corpus/011.txt --level caveman --max-words 1000 --out /tmp/p.txt && test -s /tmp/p.txt && test $(grep -c '^- ' /tmp/p.txt) -ge 3 && ! grep -q '<think>' /tmp/p.txt`; schema validation of `dial.json`; `python3 -c "import json;n=json.load(open('spec/network.json'));assert n['web'] and n['mac']"`; `test -s spec/strings/en.json`.

**S0-04b · Key facts + rubric + grader prompt** — `Sonnet` · MUST · `bootstrap` — as v3. Proof: `python3 spec/eval/validate.py` prints `30 docs, N facts, M forbidden OK`.

**S0-05 · Schemas, bench scoring, gate, baselines** — `Sonnet` · MUST · `bootstrap`
- As v3, plus: bench identity uses **major versions** of `os` and `browser`; a `baseline-reset` PR label lets a PR replace baselines when the environment legitimately changed; web `machine_id` = `"web"` unless the bench injects a real one; `gate.py --pr-head` honours `bootstrap` and `baseline-reset`.
- Proof: `python3 bench/gate.py --self-test` prints `10/10 self-tests passed`; schema validation of `bench/example-row.json` and `bench/example-report.json`.

**S0-06 · Weekly health workflow** — `Haiku` · NICE — as v3 but the model-URL check uses `curl -sIL` (the Hub answers `302` before `200`).

### Stage 1 — The Space (Thu 9/24 → Tue 9/29)

**S1-00a · Walking skeleton, local (runtime compatibility spike)** — `Codex` · MUST · `bootstrap` · **due Thu 9/24 afternoon**
- Depends on: S0-01. Parallel with: S0-02..05.
- Files: `web/package.json` (+ lockfile), `web/index.html`, `web/src/skeleton.ts`, `web/playwright.config.ts` (projects `wasm-ci`, `webgpu-local`; S1-01 extends it), `web/tests/skeleton.spec.ts`, `web/public/coi-serviceworker.js`, `docs/adr/0000-web-runtime.md`, `spec/models.json` (library versions, revision hashes), `spec/chunking.md` (the measured `tts_phoneme_limit`).
- Do: textarea → "Summarize" → bullets → spoken, no styling; pin Transformers.js 4.x + kokoro-js (or vendored loader) at versions that bundle together once; `remotePathTemplate` with hashes; vendored `af_heart`; Qwen3.5-0.8B-Text q4f16 on WebGPU, thinking off; Kokoro q8 on WASM; `coi-serviceworker`; measure the truncation limit; run against `vite preview`.
- Proof: `cd web && npm ci && npm run build && npx playwright test tests/skeleton.spec.ts --project=webgpu-local` green against `vite preview` (≥ 3 bullets, no `<think>`, `AudioContext` running with ≥ 1 s of PCM played, `crossOriginIsolated === true`); `npm ls @huggingface/transformers | grep -c "@huggingface/transformers@"` = 1; `grep -E "tts_phoneme_limit: [0-9]+" spec/chunking.md`.

**S1-00b · Walking skeleton, deployed** — `Claude` (token already in the `hf` CLI; Spaces created with `hf repo create … --repo-type space --space-sdk static`, no browser needed) · MUST · `bootstrap` · **due Thu 9/24 EOD**
- Depends on: S1-00a, S0-01 (token). Parallel with: S0-02..05.
- Files: `scripts/deploy-space.sh`, `.github/workflows/space-dev.yml`, `web/README.md` (front matter `sdk: static`, `app_file: index.html`, no build command, tags, 🦇), `spec/network.json` (observed redirect hosts).
- Do: create Spaces `2shay/fruitbat-dev` and `2shay/fruitbat` (static); deploy prebuilt `dist` + README to `-dev` with `hf upload`; wire `space-dev.yml` on push to `main`; record every request URL and redirect host from a cold load on the dev URL into `network.json`.
- Proof: `npx playwright test tests/skeleton.spec.ts --project=webgpu-local --base-url https://2shay-fruitbat-dev.static.hf.space` green (incl. `crossOriginIsolated`); `python3 -c "import json;assert json.load(open('spec/network.json'))['web']['redirect_hosts']"`; `gh run list --workflow space-dev.yml --limit 1` success.

**S1-01 · Web scaffold** — `Sonnet` · MUST · `bootstrap`
- Depends on: S1-00a, S0-04a. Files: `web/vite.config.ts` (build manifest on), `web/src/main.tsx`, `app.tsx`, `styles/`, fonts, `tests/setup.ts`, `tests/smoke.spec.ts`.
- Do: Preact + TS; Vitest; layout: article column (`011.txt`) + panel slot + header with dial; Atkinson Hyperlegible; dark mode; 16 px gutters; strings loaded from `spec/strings/en.json`; interface `window.__fruitbat = { run(text, level), stop(), stats() }`.
- Proof: `cd web && npm ci && npm run build && test -s dist/index.html && test -s dist/.vite/manifest.json && npm test && npx playwright test tests/smoke.spec.ts --project=wasm-ci`.

**S1-03a · Tokenizer, model loader, and the single network module** — `Codex` · MUST · `bootstrap` · Fri morning
- Depends on: S1-00a. Parallel with: S1-01, S1-02.
- Files: `web/src/core/tokens.ts`, `web/src/engine/net.ts` (the **only** `fetch` site; enforces `network.json`; emits the CSP list for `scripts/csp.mjs`), `web/src/engine/loader.ts` (`load(spec, onProgress, signal)`: pinned template, Cache API, resume, abort), `web/src/tests/{tokens,net,loader}.test.ts`, `spec/fixtures/tokens.web.json`.
- Do: `AutoTokenizer` through the pinned template; `countTokens()`; loader used by both S1-04 and S1-05 (owned interface); `net.ts` rejects any URL not in `network.json` (unit test with a rejected host and a rejected query string).
- Proof: `npm test -- tokens net loader` green; `tokens.web.json` has 5 entries; `scripts/check-network.sh` passes with `net.ts` as the only fetch site.

**S1-02 · Intake** — `Sonnet` · MUST (selection + paste), NICE (drop) · `bootstrap` — as v3.

**S1-03 · Segmenter, TTS-safe splitter, chunker, bullet parser, grounding v3 (TS)** — `Sonnet` · MUST · `bootstrap`
- Depends on: S0-03, S1-01, S1-03a. Fixtures as v3 plus spelled-out-number normalization ("five percent" source, "5%" bullet → kept).
- Proof: `npm test -- core` green; `python3 -c "import json;assert all(len(json.load(open(f'spec/fixtures/{n}.json')))>=8 for n in ['segment','split','chunk','bullets','ground'])"`.

**S1-04 · Voice engine: kokoro-js worker, bounded queue, playback, rate, truncation proof** — `Codex` · MUST
- Depends on: S1-03a (loader, net), S1-03 (splitter). Parallel with: S1-02, S1-05.
- Files: `web/src/workers/tts.worker.ts`, `web/src/engine/tts.ts`, `web/src/engine/audioQueue.ts`, `web/src/tests/audioQueue.test.ts`, `web/tests/readall.spec.ts`.
- Do: as v3 (pre-synthesis phoneme assertion, `TextSplitterStream`, bounded queue, `AudioContext`, `onStart/onEnd` with offsets, `AnalyserNode`, `runId`, stop ≤ 200 ms, pause/resume/skip, 2 voices) plus **speech rate** applied per segment (Kokoro `speed`), and a `speak(messageKey)` API for spoken panel messages.
- Proof: `npx playwright test tests/readall.spec.ts --project=wasm-ci` green (coverage + additivity on `020` + `tts_overlimit` = 0 + rate change audible as duration change); local `webgpu-local` writes a `RunStats` row with `rtf ≥ 1.0`, `stop_ms ≤ 200`, `coverage = 1.0`.

**S1-05 · Summarizer engine: two-stage probe, fake mode, streaming, long docs, bake-off** — `Codex` · MUST
- Depends on: S0-03, S1-03a, S1-03. Parallel with: S1-02, S1-04.
- Files: `web/src/workers/llm.worker.ts`, `web/src/workers/llm.fake.worker.ts`, `web/src/engine/llm.ts`, `web/src/engine/capabilities.ts`, `spec/fixtures/fake-llm.json`, `docs/adr/0001-web-model.md`, `web/tests/summarize.spec.ts`.
- Do: as v3, plus: on-load probe = adapter/device only; download on first summary request / explicit button with size shown (rule 11); post-download 1-token probe; `?llm=fake` worker (fixture bullets per doc, `delay_ms`, honors abort); low-end tier on memory failure. **Bake-off** as v3 on the graded set × 3 levels × 3 reps against the acceptance table (cut list allows 2 candidates × 3 docs).
- Proof: `npx playwright test tests/summarize.spec.ts --project=webgpu-local` green (≥ 1 bullet per chunk, no `<think>`, inject modes, one-line failure → Short, no model bytes fetched before the first summary request); `npx playwright test tests/summarize.spec.ts --project=wasm-ci` green with `?llm=fake` (abort honored); `docs/adr/0001-web-model.md` cites bench rows and `bench/graded/*`; `test -s bench/last-run/short-011.txt`.

**S1-06 · Orchestrator, dual state machine, cancellation, controls, spoken dial notice** — `Codex` · MUST
- Depends on: S1-03, S1-04, S1-05. As v3 plus: dial change speaks the notice ≤ 500 ms; all-cut → spoken notice + "Read this part" offer; Read-all cursor events for the large-sentence view; input-limit message spoken.
- Proof: `npm test -- state` green; `npx playwright test tests/dial.spec.ts --project=wasm-ci` green with `?llm=fake` (delayed completion dropped, correct chunk restarted, rapid re-select, Esc ≤ 200 ms mid-generation, dial notice ≤ 500 ms); stats row has non-null `ttfa_ms`.

**S1-L0 · Product copy** — `Claude` (Voice Bank pre-flight; caveman-lite register for the Caveman level's own labels) · MUST · Sun
- Depends on: S0-03 (keys). Parallel with: S1-07..13.
- Files: `spec/strings/en.json` (all values), `docs/launch/strings-review.md`.
- Do: every panel label, control name, loading line, error, notice, permission sentence (Mac keys too), in plain words, read aloud once; `vh capture snapshot` on the file. S1-07 and S1-09 consume it; no string literal in `web/src/ui`.
- Proof: `node scripts/strings-check.mjs` finds 0 placeholder values and 0 string literals in `web/src/ui/**`; capture id logged.

**S1-07 · Panel UI** — `Sonnet` + `impeccable` · MUST (basic), NICE (position setting)
- Depends on: S1-06, S1-L0. As v3 plus: **rate slider**, Read-all view (current sentence large, next dimmed), "Read this part" button, `aria-live`, strings from `en.json` only.
- Proof: `npx playwright test tests/a11y.spec.ts tests/panel.spec.ts --project=wasm-ci` green (axe 0 serious/critical; contrast ≥ 4.5:1; rate persists across reload); screenshots exist and are non-empty.

**S1-08 · Pip (code-drawn placeholder)** — `Sonnet` · static MUST, animation NICE — as v3; `brand/BRAND.md` states the placeholder is unprotected until the illustrator's art.

**S1-09 · Loading UX + canned demo (all four levels)** — `Sonnet` · MUST
- Depends on: S1-04, S1-05, S1-06, S1-L0. Files as v3 plus `web/public/demo/{readall,short,caveman,oneline}.{json,wav}`.
- Do: rule 11 flows (sizes shown before download; `saveData`; mobile); progress with MB; cache detection; canned demo for all four levels of doc `011`, dial works on it everywhere, labeled as a recording; `make-demo.mjs` regenerates.
- Proof: `npx playwright test tests/loading.spec.ts --project=wasm-ci` (route-throttled, `?llm=fake`) asserts: no model request before the first summary click, audio within 1 s of "Try it now", dial switches the recording, bars reach 100 %; `ls web/public/demo/*.wav | wc -l` = 4.

**S1-10 · Stats store** — `Sonnet` · MUST (store), NICE (view) — as v3.
**S1-11 · Bug report button + issue form** — `Sonnet` · MUST — as v3.

**S1-12 · Privacy proof + CSP** — `Sonnet` · MUST
- Depends on: S0-02, S0-03, S1-01, S1-03a, S1-06. Files: `web/tests/privacy.spec.ts`, `scripts/csp.mjs`, `scripts/privacy-md.mjs`, `PRIVACY.md`.
- Do: as v3 (exact URLs, no query strings, canary forms in URL/headers/body, stubbed channels, request count) plus: `csp.mjs` generates the `<meta http-equiv="Content-Security-Policy">` with `connect-src` from `network.json` into `index.html` at build; the test asserts the meta is present and that a deliberate off-list fetch is **blocked by the browser**, not just by our code; `PRIVACY.md` generated from `network.json`, states the Polar cadence and the Sparkle toggle.
- Proof: `npx playwright test tests/privacy.spec.ts --project=wasm-ci` green (with `?llm=fake` for the levels); `--project=webgpu-local` green locally with `docs/qa/privacy-requests-<commit>.json` non-empty; `node scripts/privacy-md.mjs --check` and `node scripts/csp.mjs --check` exit 0.

**S1-13 · Web bench runner + memory harness** — `Sonnet` · MUST (cut list: NICE) — as v3.

**S1-14 · Browser matrix + fixes + graded pass** — `Codex` · MUST (Chrome + Safari) — as v3.

**S1-15 · Deploys: dev on push, public on `web-v*`, Mac on `mac-v*`** — `Sonnet` · MUST
- Depends on: S1-00b. Files: `.github/workflows/release.yml`, `scripts/release-check.sh`, `web/README.md`.
- Do: `release.yml` branches on tag prefix: `web-v*` → `release-check.sh` → `hf upload` to `2shay/fruitbat`; `mac-v*` → `release-check.sh` → hand-off to `release.sh` (S2-12). Dev deploy already wired in S1-00b.
- Proof: a test tag `web-v0.0.1-test` runs `release.yml`, `release-check` passes (or fails loudly with the reason), and the public Space updates; `gh run list --workflow release.yml --limit 1` shows the run.

**S1-16 · Live gate (Tue 9/29)** — `Claude` runs it, Akshay signs · MUST
- Depends on: S1-14, S1-15. Files: `docs/qa/live-gate-2026-09-29.md`, `CHANGELOG.md`, `spec/version.json`.
- Do: freeze `main` → `bench/run.sh --target web` on `main` HEAD → commit rows → `scripts/release-check.sh` on the rows commit → tag `web-v0.1.0` on it → public Space updates → the full acceptance table from the public URL (cold, then warm) → privacy `webgpu-local` run against the public URL → README quickstart followed literally → Space Files tab shows source.
- Proof: the gate file with every row's measured number and the commit; `git tag --points-at HEAD | grep -c web-v0.1.0` = 1; `test -s docs/qa/privacy-requests-<commit>.json`.

**S1-L1 · Application text** — `Claude` (Voice Bank) · MUST. ≤ 120 words; Space link; `vh capture snapshot`; Akshay submits. Proof: confirmation screenshot.
**S1-L2 · Small launch post** — `Claude` (Voice Bank, `post.md`) · NICE.
**S1-L3 · Note to the illustrator + copyright handover line** — `Claude` (Voice Bank, personal text) · **not before the Mac app works** (Akshay, 2026-09-23). Stage 1 and the demo ship the placeholder Pip.
**S1-L4 · Demo-day runbook + rehearsal** — `Claude` · MUST before Oct 16 · Sep 30 buffer
- Files: `docs/launch/demo-day.md`; `?models=local` flag in the loader (serves pinned files from same-origin `public/models/` on the demo laptop's local build).
- Do: venue-wifi plan (models pre-cached in the demo browser profile **and** a local static build with the model files in `public/models/`), cache-eviction check, offline path proven, spare laptop steps, Pip stickers.
- Proof: with Wi-Fi off, the local build speaks a Short summary; logged in the runbook.

### Stage 2 — The Mac app (Oct 1 → late Oct; S2-00..02 may start any time)

_Working product first. S2-11 (license), S2-15 (Polar), and the paid-build parts of S2-12 are **Stage 2b**, built only after Akshay decides to monetize. Signing/notarization (S2-00 Apple account, S2-12) is still needed the moment anyone other than Akshay installs the app, paid or free._

**S2-00 · Toolchain + accounts** — `Haiku` checklist; Akshay does the account steps — as v3 plus `brew install mitmproxy`; proof adds `which mitmproxy`.
**S2-01 · SwiftPM skeleton + spec loader + NetworkPolicy** — `Sonnet` — as v3; strings from `spec/strings/en.json`.
**S2-02 · Core text ops (Swift) against shared fixtures** — `Sonnet` — as v3; token fixtures are `tokens.mac.json` (Mac tokenizer), core fixture count excludes token files.
**S2-03a · Mac engine spike, decision Oct 3** — `Codex` — as v3.
**S2-03 · LLM engine (production)** — `Codex` — as v3.
**S2-04 · TTS engine + audio queue (production)** — `Codex` — as v3 plus rate and `speak(messageKey)`.
**S2-05 · Pipeline + CLI parity** — `Codex` — as v3.

**S2-06 · Intake: AX selection, clipboard hotkey, region OCR, arm-and-watch** — `Codex`
- Depends on: S2-01. Files: `Sources/FruitbatCore/Intake/{Selection,Clipboard,Region,OCR,ArmAndWatch}.swift`, `mac/App/RegionPicker/`, `docs/qa/mac-intake.md`, tests.
- Do: per Architecture "Intake": no `CGEvent` key posting anywhere in the target (a test greps for `CGEvent` and `kVK_ANSI_C`); arm-and-watch: spoken prompt, 5 s window, run on `changeCount` advance, cancel on Esc or timeout with a spoken "Didn't see a copy."; OCR + region picker; first-OCR warning. Automatic ⌘C is roadmap only (C9 locked).
- Proof: `swift test --filter IntakeTests` green (arm-and-watch: advance within window → run; no advance → cancel; advance after timeout → ignored; OCR fixture ≥ 95 %); `! grep -rn "CGEvent(keyboardEventSource" mac/Sources`; `docs/qa/mac-intake.md` filled for Safari, Chrome, Preview, Notes, VS Code, Slack, Mail × {AX, hotkey, arm-and-watch, region}.

**S2-07 · Menu-bar app, panel, settings, hotkeys** — `Sonnet` — as v3 plus rate, Read-all large-sentence view, "Speak messages" toggle.

**S2-08 · Onboarding + just-in-time permissions** — `Codex` (copy from `en.json`)
- Depends on: S2-06, S2-07. Do: per Architecture "Permissions, just in time": permission-free first run (copy → `⌃⌥V` → first success), then the Accessibility offer, Screen Recording on first region hotkey; live grant detection; fallbacks on denial.
- Proof: `docs/qa/mac-onboarding-fresh-user.md` with screenshots from a fresh user account showing the first success **before** any permission prompt; every denial path exercised; `swift test --filter PermissionsTests` green.

**S2-09 · Pip in the panel** — `Sonnet` — as v3.
**S2-10 · Stats window, local metrics, crash counter, bug report** — `Sonnet` — as v3.

**S2-11 · Trial + Polar license (weekly validate, nag-never-lock)** — `Codex` · **Stage 2b, deferred**
- Depends on: S2-07, S2-15. Do: per Architecture; validation scheduler (≥ 7 days between validates); grace 14 days → nag banner, never lock; deactivate.
- Proof: `swift test --filter LicenseTests` green for: valid; invalid at activation; revoked (nag, still runs); activation limit; wrong benefit; offline within grace (silent); offline past grace (nag, still runs); validate not called twice within 7 days; deactivate; sandbox purchase → "Licensed".

**S2-12 · Sparkle + release script + notarization** — `Codex`
- Depends on: S2-00, S2-07, S1-15. Do: per Architecture; `gh-pages` appcast publish; `mac-v*` tag flow.
- Proof: `spctl -a -vv Fruitbat.app` → `accepted, source=Notarized Developer ID`; quarantined DMG opens on a clean account; Sparkle update there; `curl -sf https://aj-prabhu.github.io/fruitbat/appcast.xml | grep -c "<item>"` ≥ 1; a subsequent `web-v*` tag leaves the appcast URL unchanged (checked in `docs/release.md`).

**S2-13 · Mac bench + pre-push gate** — `Sonnet` — as v3.
**S2-14 · Mac QA pass + payload-level network audit (mitmproxy)** — `Claude` reviews, `Codex` fixes — as v3, plus: assert no validate call happened more than once in the 10-minute session.
**S2-15 · Polar product** — Akshay in Polar; `Claude` drafts copy — as v3 · **Stage 2b, deferred**.
**S2-L1 · Landing page + big post + Homebrew cask** — `Claude` (Voice Bank), `Haiku` for the cask — as v3.

### Dependency graph

```
S0-01 ─┬─ S0-02 ─────────────────────────────────────┐
       ├─ S0-04a ─┬─ S0-03 ─┬─ S1-03 ─┐              │
       │          └─ S0-04b ─┴─ S0-05 ─┼─ S1-13 ──────┐
       └─ S1-00a ─┬─ S1-00b ───────────┤              │
       (Thu)      ├─ S1-03a ─┬─ S1-04 ─┼─ S1-06 ─┬─ S1-07 (needs S1-L0) ┐
                  │          └─ S1-05 ─┘         ├─ S1-08                ├─ S1-14 ─ S1-16 ─ S1-L1
                  └─ S1-01 ─── S1-02             ├─ S1-09 (needs S1-L0) │
                                                  ├─ S1-10 ─ S1-11       │
                                                  └─ S1-12 ──────────────┘
S1-00b ── S1-15 (release.yml)                     S1-L0 (Sun) ─ S1-07 / S1-09
S2-00 ─┐
S0-03 ─┴─ S2-01 ─┬─ S2-02 ──────────┐
S0-05 ─┘         └─ S2-03a ─┬─ S2-03 ┼─ S2-05 ─┬─ S2-07 ─┬─ S2-08 ─┐
                 (Oct 3)    └─ S2-04 ┘         ├─ S2-06 ─┘        ├─ S2-09
                                               └─ S2-13           ├─ S2-10 ─ S2-14 ─ S2-L1
                                                                  ├─ S2-11 (needs S2-15)
                                                                  └─ S2-12 (needs S2-00, S1-15)
```

---

## QA plan

**Unit** (Vitest / XCTest, CI on every PR): segmenter, TTS-safe splitter, chunker, bullet parser, grounding v3 (incl. spelled-out numbers, invented sentence-initial name, common word, all-cut signal), both state machines, `runId` staleness, audio queue bounds/stop/rate, schema validation, report builder, spec/strings loader, `net.ts` / `NetworkPolicy` allowlists, arm-and-watch.

**End-to-end** (Playwright; CI runs `wasm-ci` with `?llm=fake`, local runs `webgpu-local`): skeleton (local + dev URL, `crossOriginIsolated`), smoke, intake, read-all (coverage + additivity + overlimit + rate), summarize (probe stages, inject modes, one-line failure policy, no download before request), dial (delayed completion, rapid re-select, Esc mid-generation, spoken notice), loading (four-level demo), a11y, privacy (exact URLs, CSP block, canary forms, stubbed channels), panel screenshots. Mac: `fruitbat-cli` + checklists.

**Manual gates**: S1-00a/b, S1-14, S1-16, S1-L4, S2-03a, S2-06, S2-08, S2-14. Every gate is a file with numbers.

**`scripts/release-check.sh <commit>`** (rule 10): unit + `wasm-ci` e2e green for the commit; `check-logs`, `check-network`, `gitleaks` green; `bench-gate` green with rows valid for the commit (or, under the cut list, a hand-filled gate file); `score.py` floors; graded files for the graded set × 3 levels, every score ≥ 4/5, rerun whenever a model, prompt, chunking, or grounding file changed since the last release; `spec/version.json` bumped and `CHANGELOG.md` entry; privacy `webgpu-local` request log present; `strings-check` clean. Exit non-zero on any miss.

**Accessibility**: axe 0 serious; contrast ≥ 4.5:1; keyboard-only; `aria-live`; VoiceOver; reduced motion; font size + spacing; rate; spoken messages.

**Long-doc and soak**: 12,000-word doc at every level on both targets; 100-chunk limit exercised; 2-hour Mac soak.

---

## Bug-report pipeline

1. **Capture** (S1-11, S2-10): `BugReport` envelope, previewed; never source text, bullets, audio, file names, or URLs; description never persisted.
2. **Transport**: GitHub issue form via field params, opened and submitted by the user. Copy fallback. No server.
3. **Triage**: label `bug`; weekly and on demand Claude runs `/triage` (`.claude/commands/triage.md`, created in S0-02): reproduce with corpus + CLI/bench, classify, ask one question or open `fix/<issue>-<slug>` with bench rows; Codex cross-inspects the diff.
4. **Approval**: **Akshay merges every fix PR by hand**, from a Claude Code session so the hook fires.
5. **Close the loop**: merge comment names the version; the next `web-v*` / `mac-v*` tag ships it.
6. **Security reports**: GitHub private vulnerability reporting.

---

## KPIs

| KPI | Definition | Measured by | Target (M1 Pro, warm) | Gate |
|---|---|---|---|---|
| Cold download budget | voice + LLM + voices | `models.json`, privacy request log | ≤ 700 MB | floor |
| Time to first audio | trigger → first sample | stats, bench (3 reps, median) | Web: Read all ≤ 3 s, Short ≤ 8 s; cold first summary ≤ 90 s from request. Mac: ≤ 1.5 s / ≤ 4 s. | +20 % or floor |
| Dial-change silence | dial → spoken notice | e2e | ≤ 500 ms | blocks |
| Tokens per second | decode rate | engine timer | Web ≥ 15; Mac ≥ 40 | −15 % or floor |
| Voice stream smoothness | RTF, inter-segment gap | audio queue | RTF ≥ 1.0 web, ≥ 2 mac; gap ≤ 150 ms | gap +50 ms |
| Read-all coverage | tiling, additivity, `tts_overlimit` | coverage test | 100 % / 10 % / 0 | blocks |
| Faithfulness, diagnostic | `facts_token_hit`, `halluc_flags`, `forbidden_hits`, `oneline_keyword_hit` | `score.py` | ≥ 90/75/60 %; 0; 0; ≥ 80 % | −5 pts or any flag |
| Faithfulness, graded | rubric, full source, graded set × 3 levels | `grade.md` | ≥ 4/5 every level | in `release-check.sh` |
| Cut rate | drops / bullets | counter | ≤ 10 % at Short | informational |
| Stop latency | Esc → silence | e2e | ≤ 200 ms | blocks |
| Crash rate | per 100 sessions (local) | crash marker; e2e errors | Mac < 1/100; web 0 in e2e | e2e error blocks |
| Upkeep health | weekly `health.yml` | Actions | green weekly | informational |
| Peak memory | Mac RSS (12,000 words, Short); web RSS informational, heap separate | `/usr/bin/time -l`; harness | Mac ≤ 4 GB | Mac +25 % |

---

## Assumptions (confirmed ledger + this session's checks)

1–22 as v3 (ledger items, Hub sizes, Apple FM off on his Mac, MLX/Polar/HF facts, machine state, the illustrator, direction table, issue-form params, HF static `app_file`, clipboard ownership unprovable). Plus:
23. The Codex review gate is a Claude Code hook in `~/.claude/settings.json` (`crossreview/hooks/codex-gate.sh`, matcher `Bash`, PreToolUse + PostToolUse); it fires only for `gh pr …` commands run from a Claude Code session. — verified 2026-09-23.
24. `~/.claude/skills/caveman` does not exist; the register is `~/.claude/output-styles/caveman-lite.md`. — verified 2026-09-23.
25. `hf`, `gitleaks`, `mitmproxy` are not installed. — verified 2026-09-23.
26. `codex-build` excludes work needing secrets, a browser session, or MCP; such packets are `Claude`-tagged. — skill description.
27. Static Spaces cannot set COOP/COEP; `coi-serviceworker` is the standard workaround; unverified until S1-00a. — Fable pass.
28. Global hotkeys (Carbon `RegisterEventHotKey` / `KeyboardShortcuts`) need no macOS permission; reading a selection via AX needs Accessibility; region capture needs Screen Recording. — Apple docs.

---

## Risks / open questions

| Risk | Mitigation | Owner |
|---|---|---|
| Runtime mismatch or Qwen3.5 ONNX not generating in the browser. | S1-00a Thu; fallbacks A/B, low-end tier; vendored loader. | S1-00a |
| `crossOriginIsolated` unattainable on a static Space → single-threaded WASM below real time. | S1-00a asserts it; else restate WASM floors before S1-04 merges; WebGPU is the main path anyway. | S1-00a |
| Safari 26 q4f16 wrong output. | S1-14; `q4` or fallback A by UA. | S1-14 |
| Cold download too slow for reviewers. | 700 MB floor; nothing downloads unasked; four-level canned demo. | S1-05, S1-09 |
| Safari evicts the model cache. | Measure; say so in the UI. | S1-14 |
| Hallucination survives grounding. | Graded pass on all levels in `release-check.sh`; Read all always visible. | release-check |
| **No slack on the 9/29 path.** | Merge on demand for critical-path PRs; the cut list in Approach, in order. | Akshay |
| CI tests "pass" without an LLM. | `?llm=fake` is named in every `wasm-ci` spec; `summarize.spec.ts` asserts abort is honored by the fake. | S1-05 |
| mlx-audio-swift immature / G2P assets / offline fails. | S2-03a inventory + offline test; `sherpa-onnx`; ADR 0003. | S2-03a |
| Apple Developer enrollment delayed. | Needed only when someone other than Akshay installs the Mac app (free or paid). Not before mid-Oct. | Akshay |
| AX selection fails in some apps. | `⌃⌥V`, arm-and-watch, region OCR; intake matrix. | S2-06 |
| OCR reads a password aloud. | Region default; first-run warning. | S2-06 |
| SDKs bypass `NetworkPolicy`. | mitmproxy capture in S2-14. | S2-14 |
| Web tag breaks Mac updates. | Separate namespaces; fixed appcast URL (C13). | S1-15, S2-12 |
| Sparkle key / Polar ids lost or leaked. | Claude vault; `gitleaks` in CI. | S2-12 |
| Placeholder Pip is unprotected art. | Stated in `brand/BRAND.md`; the illustrator's art replaces it once the Mac app works. | S1-08 |
| Demo-day wifi. | S1-L4 runbook + offline local build, rehearsed Sep 30. | S1-L4 |
| **Open:** exact Hub redirect hosts. | S1-00b records them. | S1-00b |
| **Open:** Homebrew tap vs core cask. | S2-L1. | |
| **Open:** "Fruitbat" trademark search; `.app`/`.dev` domains. | Before buying a domain. | Akshay |

---

## Out of scope (v1)

Dictation (roadmap); Apple FM engine (roadmap); opt-in anonymous stats (roadmap, consent rules fixed); iOS, Windows, Linux, Intel Macs, App Store, browser extensions; cloud inference, accounts, sync, HF Storage Buckets; word-level highlight; non-English; custom prompts / Q&A; quality mode with a 2B web model; documents over 100 chunks; automatic ⌘C (roadmap only if arm-and-watch proves insufficient).

## Roadmap (after v1)

Dictation → "mini bot"; Apple FM engine option; opt-in stats; the illustrator's Pip everywhere + stickers; speculative dial pre-generation; quality mode; more languages; word-level highlight; Homebrew core cask; Windows if demand shows.
