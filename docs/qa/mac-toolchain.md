# S2-00 — Mac toolchain checklist

Checked 2026-09-23 on this bench. Status: `done` / `Akshay` / `later`.

## Checklist

| Item | Status | Command / proof |
|---|---|---|
| Xcode 26 from the App Store, then `sudo xcode-select -s /Applications/Xcode.app` | Akshay | Not installed today. Only Command Line Tools present (`xcode-select -p` → `/Library/Developer/CommandLineTools`). The App Store install and the `sudo` switch are his to run. |
| `xcodebuild -version` prints `26.x` | pending | Today: `xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance`. Waits on the row above. |
| Swift 6.4 present | done | `swift --version` → `swift-driver version: 1.168.6 Apple Swift version 6.4 (swiftlang-6.4.0.34.1 clang-2100.3.34.1)` |
| Apple Developer Program enrollment | Akshay | Only needed once someone other than Akshay installs the app (plan Q2 / S2-12 note). Not required for Akshay-only builds. |
| Developer ID Application certificate | Akshay, later | Today: `security find-identity -v -p codesigning` → `0 valid identities found`. Needs the enrollment above first. |
| `notarytool` credentials, keychain profile `fruitbat`; app-specific password in the 1Password Claude vault | Akshay, later | Today: `xcrun notarytool history --keychain-profile fruitbat` → `Error: No Keychain password item found for profile: fruitbat`. Run `notarytool store-credentials` once the cert exists; store the app-specific password in the Claude vault, not just the keychain. |
| `mlx-swift-lm` skill on both benches | Akshay | Exact commands and smoke test below. |
| `mitmproxy` installed | done | `mitmproxy --version` → `Mitmproxy: 12.2.3 binary` |

## mlx-swift-lm skill install (Akshay)

Looked this up read-only (no copy made outside `/tmp`): upstream repo `ml-explore/mlx-swift-lm`, skill folder `skills/mlx-swift-lm`, `SKILL.md` present. Verified 2026-09-23 at commit `ee673d6a71d76e67b532dc7eaf91d92edc3bb8bb`.

No agent session can do this install: `~/.claude` and `~/.codex` are reserved for Akshay, so a Claude Code or Codex session is not allowed to write inside either directory. Run these yourself:

```bash
git clone https://github.com/ml-explore/mlx-swift-lm.git /tmp/mlx-swift-lm
cp -R /tmp/mlx-swift-lm/skills/mlx-swift-lm ~/.claude/skills/mlx-swift-lm
cp -R /tmp/mlx-swift-lm/skills/mlx-swift-lm ~/.codex/skills/mlx-swift-lm
```

Then smoke-test on the Codex bench, read-only, to confirm the skill loads:

```bash
echo "Name this skill's purpose in one line." > prompt.txt
codex exec -s read-only -o /tmp/out.txt - < prompt.txt
cat /tmp/out.txt
```

Repeat the same prompt check on the Claude bench once its skill is in place.

## Proof (packet S2-00, run 2026-09-23)

- `which mitmproxy && mitmproxy --version` → `/opt/homebrew/bin/mitmproxy`, `Mitmproxy: 12.2.3 binary` — **pass**
- `swift --version` → Swift 6.4 line above — **pass**
- `xcodebuild -version` → CLT-only error, no Xcode — **fails today**, expected until Xcode 26 is installed
- `security find-identity -v -p codesigning` → `0 valid identities found` — **fails today**, expected until the Developer ID Application cert exists
- `xcrun notarytool history --keychain-profile fruitbat` → no keychain item for that profile — **fails today**, expected until `store-credentials` is run
- `ls ~/.claude/skills/mlx-swift-lm` and `ls ~/.codex/skills/mlx-swift-lm` → neither exists — **fails today**, expected until the `cp -R` install runs

Every failure above is expected: it clears once Akshay does the matching Akshay-owned row. Nothing here indicates a broken toolchain.
