# AGENTS.md — house rules

Fruitbat is a tool for people with low reading bandwidth: highlight text, press
a hotkey, get a small panel of TLDR bullets read aloud as they appear. Two
targets share one spec: a static web demo (Hugging Face Space) and a native
macOS menu-bar app. This file is the rulebook for any agent or human touching
this repo — what's non-negotiable, what's expected of a PR, and where things
live. Read `docs/PLAN.md` for the full plan; this file is the enforced subset.

---

## The 11 non-negotiables

**1. Text never leaves the device.** No telemetry. The only outbound traffic:
pinned model downloads from Hugging Face, a bug report the user previews and
sends themselves, and on Mac only, Polar license checks and Sparkle update
checks. Logs are numbers and enums only, never source text.
Enforced by: `scripts/check-network.sh`, `scripts/check-logs.sh`, the privacy
e2e (`web/tests/privacy.spec.ts`), and the generated CSP (`scripts/csp.mjs`).

**2. "Read all" is always one key away, and it reads all of it.** Every
synthesis call is checked against the voice model's token limit before it
runs. If a chunk's bullets all fail the grounding check, the panel says so and
offers "Read this part" instead of guessing.
Enforced by: the TTS-safe splitter's pre-synthesis assertion and the coverage
test (S1-04); the all-cut fallback path in the orchestrator (S1-06).

**3. No merge without a bench run.** Every PR needs bench rows committed on
top of the tested commit, or the `bootstrap` label for foundation packets
before the bench runner exists.
Enforced by: `bench/gate.py --pr-head` in the `bench-gate` CI job; the
`bootstrap` label. (`bench/gate.py` lands in packet S0-05.)

**4. Models and runtimes are pinned.** Repo id + revision hash for every
model file and voice; exact npm/SwiftPM versions for every inference library.
Enforced by: `spec/models.json` plus lockfiles (`web/package-lock.json`,
`mac/Package.resolved`). (`spec/models.json` lands in packet S0-03.)

**5. Akshay approves every merge.** Agents open PRs; nobody auto-merges. PRs
are opened and merged only from a Claude Code session, so the Codex review
hook fires and blocks on open P1/P2 findings. Never run `gh pr create` or
`gh pr merge` from a plain terminal.
Enforced by: the `codex-gate.sh` Claude Code hook (`~/.claude/settings.json`,
matcher `Bash`).

**6. One branch per packet.** Branch names are `pkt/<ID>-<slug>` (bug fixes:
`fix/<issue>-<slug>`). PR titles start with the packet ID. Every packet's
Proof must fail on a missing or empty artifact, not pass silently.
Enforced by: `CONTRIBUTING.md` branch-naming convention;
`.github/PULL_REQUEST_TEMPLATE.md` requires the packet ID as the first line.

**7. Shared spec is the source of truth.** Dial levels, prompts, chunking,
grounding, schemas, and the eval corpus live in `spec/`. Web and Mac both load
it. Neither target hard-codes a prompt or a rule the spec already states.
Enforced by: nothing hard-codable — code review is the check. (`spec/`
skeleton lands in packet S0-03.)

**8. Human-facing text goes through the Voice Bank protocol.** Every string a
user sees or hears — panel labels, errors, onboarding, product copy — is
written in packet S1-L0, not invented inline in a UI packet. Every panel
message is also spoken.
Enforced by: `spec/strings/en.json` is the only source of user-facing text;
`scripts/strings-check.mjs` fails on a string literal in UI code or a
placeholder value. (Both land alongside S1-L0 / S0-03.)

**9. Walking skeleton first.** No UI, brand, or stats packet merges before
S1-00a/b prove real text → real summary → real audio, locally and on the
deployed dev Space.
Enforced by: the dependency graph in `docs/PLAN.md` — packets after S1-00b
declare it as a hard dependency.

**10. A release is a tag.** `web-v*` publishes the public Space; `mac-v*`
publishes a GitHub Release + appcast. Every push to `main` deploys to the dev
Space. Release rows are frozen, gated, and tagged in that order.
Enforced by: `scripts/release-check.sh <commit>`, run before every tag.
(Lands in packet S1-15 web-side, S2-12 Mac-side.)

**11. Nothing big downloads without asking.** Page load only probes the
WebGPU adapter (milliseconds). The voice model loads automatically unless the
device signals low bandwidth or is mobile. The summarizer downloads only on
the first summary request or an explicit button that shows its size first.
Enforced by: the two-stage probe and download gating in `web/src/engine/llm.ts`
(S1-05); the loading e2e (`web/tests/loading.spec.ts`, S1-09).

---

## Working rules for agents

- One branch per packet: `pkt/<ID>-<slug>`. Bug fixes: `fix/<issue>-<slug>`.
- PR title starts with the packet ID.
- Merge commits only. Never squash, never rebase-merge — it would break bench
  row validity (see `CONTRIBUTING.md`).
- Every PR needs bench rows on top of the tested commit, or the `bootstrap`
  label.
- Read the packet's Proof in `docs/PLAN.md` before starting. Make the Proof
  fail on a missing or empty artifact — don't write a check that passes
  vacuously.
- Never log source text, bullets, audio, file names, or URLs of what the user
  was reading. Numbers and enums only.
- Never add a `fetch` call outside `web/src/engine/net.ts` (or
  `URLSession` outside `mac/Sources/FruitbatCore/NetworkPolicy.swift` on Mac).
- All human-facing strings live in `spec/strings/en.json`. No string literals
  in UI code.
- Commit with DCO sign-off (`git commit -s`).

---

## Dependencies

| Name | Version | License | Why |
|---|---|---|---|
| `@huggingface/transformers` | 4.3.0 | Apache-2.0 | In-browser model inference |
| `phonemizer` | 1.2.1 | MIT | G2P for Kokoro TTS |
| `kokoro-js` loader | vendored | Apache-2.0 | Vendored because the npm package pins Transformers.js 3.x; we're on 4.x |
| `vite` | pinned in S1-00a / S1-01 | MIT | Build tool |
| `typescript` | pinned in S1-00a / S1-01 | Apache-2.0 | Types |
| `preact` | pinned in S1-00a / S1-01 | MIT | UI framework |
| `vitest` | pinned in S1-00a / S1-01 | MIT | Unit tests |
| `@playwright/test` | pinned in S1-00a / S1-01 | Apache-2.0 | E2E tests |
| Python (stdlib only) | — | — | `spec/eval/validate.py` |
| `jsonschema` (Python) | — | MIT | `bench/gate.py` self-tests |

**Models** (pinned repo id + revision in `spec/models.json`):

| Model | License |
|---|---|
| `onnx-community/Qwen3.5-0.8B-Text-ONNX` | per model card, revision pinned in `spec/models.json` |
| `onnx-community/Kokoro-82M-v1.0-ONNX` | Apache-2.0 |

Exact versions not yet locked here are pinned in packets S1-00a / S1-01;
`spec/models.json` lands in S0-03.

---

## Logger contract

```
log(event: Event, fields: { [k: string]: number | Enum })
```

`Event` is an enum listed in `spec/schemas/event.schema.json` (lands in
packet S0-05). Fields are numbers and enum strings only. Never source text,
bullets, audio, file names, or URLs.

The logger module is the **only** place `console.*` (or `NSLog` / `os_log` /
`print` on Mac) may be called:

- `web/src/engine/log.ts`
- `mac/Sources/FruitbatCore/Log.swift`

Everywhere else, `scripts/check-logs.sh` fails the build.

---

## Where things are

| Directory | Purpose |
|---|---|
| `spec/` | Shared spec loaded by both web and macOS targets: dial levels, prompts, chunking, grounding, schemas, eval corpus |
| `web/` | Stage 1: static web app demo (Vite + TS + Preact) on Hugging Face Spaces |
| `mac/` | Stage 2: native macOS menu-bar app (SwiftPM) |
| `bench/` | Benchmarks and performance gates (`run.sh`, `gate.py`, `score.py`, `baselines.json`, `results.csv`) |
| `brand/` | Protected brand assets (name, Pip, logo) — all rights reserved, separate license from the code |
| `docs/` | Plan, architecture decision records, QA gate files, research |
| `scripts/` | Deploy, release, and check scripts |
| `.github/workflows/` | CI, dev-Space deploy, release, weekly health |
| `.claude/commands/` | Slash commands, including `/triage` |

---

Full context: `docs/PLAN.md`. If this file and the plan disagree, the plan
wins and this file needs an update.
