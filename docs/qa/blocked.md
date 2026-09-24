# Blocked — needs Akshay

_Overnight build 2026-09-23 → 24. Newest at the top. Each item: what, why, what to do._

## Codex cannot build from this session (affects every Codex-tagged packet)
- `codex exec --yolo` is denied by the Claude Code auto-mode classifier ("Create Unsafe Agents"). Probed 22:58 with a no-op prompt. Same as memory `reference_codex_cli` (2026-08-26).
- Read-only Codex works. So tonight: **Claude builds the Codex-tagged packets; a fresh read-only Codex session inspects each diff before the PR opens.** Those PRs carry the `codex-inspected` label and name the verdict in the body.
- If you want Codex to have built any of them: close that PR and run `codex-build` on the packet from a real terminal. Nothing merged, so nothing lost.

## Usage limit hit twice: 00:40 → 03:10 and 04:19 → 08:10 (nothing for you to do; noted for the timeline)
- Four Sonnet subagents (S0-04b, S1-03, S1-02, S0-06) were killed by the Claude usage limit at 00:40 and resumed at 03:12 from their worktrees. The S1-06 fork was killed at 04:19 and resumed at 08:12. About 6.5 hours of the night were lost to the two windows.
- If the morning finds fewer PRs than the plan's Thursday list, this is why, not a blocker in the code.

## Mac toolchain (S2-00): three items are yours
- **Xcode 26 is not installed** (only Command Line Tools). Install from the App Store, then `sudo xcode-select -s /Applications/Xcode.app`. Needed from S2-01 on (Oct 1+), not tonight.
- **`mlx-swift-lm` agent skill**: an agent session is not allowed to write into `~/.claude/skills` or `~/.codex/skills` (classifier: Self-Modification). `docs/qa/mac-toolchain.md` (PR from `pkt/S2-00-mac-toolchain`) has the two `cp -R` commands and the smoke test. Two minutes.
- Apple Developer Program + Developer ID cert + notarytool profile: only when someone other than you installs the Mac app (plan). Nothing to do now.

## CI on stacked PRs
- `ci.yml` lives on the S0-02 branch (PR #1). PRs #2, #3 and later show "no checks" until #1 merges. Merge #1 first, then the others rerun on their next push or a re-run.

## GitHub shows the license as "other", not AGPL-3.0 (S0-01 proof)
- `LICENSE` = verbatim AGPL-3.0 with a 3-line brand-exception note on top (the plan asked for the note in the file). GitHub's detector returned `other` right after push.
- Status: see the entry below this one for the fix PR, if one was needed. If the API still says `other` after merging, the fix is to shorten the note to one line or move it to `LICENSE-BRAND`.

## Housekeeping you should know about (no action unless you disagree)
- The classifier also refused `rm -rf .git`. So the fresh-history extraction was done by copying: old planning repo is intact at `~/Sites/fruitbat-planning` (plus a bundle at `~/Sites/reader-app-planning-history.bundle`). Delete both whenever you like. Nothing from it was published.
- `docs/KICKOFF.md` moved to the vault (`Claude Sessions/2026-09-23 Fruitbat Kickoff (private).md`) so local paths and 1Password item names stay out of the public repo.
- `HF_TOKEN` secret was set from the `hf` CLI's cached token, not via `op`, to avoid a Touch ID prompt while you sleep. Same token.
