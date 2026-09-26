#!/usr/bin/env bash
# check-network.sh — fail if anything routes around the single network module.
#
# Scope: web/src/ and mac/Sources/ only. Skips cleanly if neither exists.
# Excludes: test files only. web/src/vendor/ is IN scope — vendored code
# must also route through net.ts.
#
# Fails on: WebSocket, RTCPeerConnection, sendBeacon, EventSource,
# XMLHttpRequest anywhere; navigator.serviceWorker.register outside
# web/src/main.ts*; raw fetch( (any whitespace before the paren) anywhere except web/src/engine/net.ts and
# mac/Sources/FruitbatCore/NetworkPolicy.swift; on Mac, also URLSession.shared
# and URLSession(configuration outside NetworkPolicy.swift.
set -euo pipefail

SCAN_DIRS=()
[ -d web/src ] && SCAN_DIRS+=(web/src)
[ -d mac/Sources ] && SCAN_DIRS+=(mac/Sources)

if [ ${#SCAN_DIRS[@]} -eq 0 ]; then
  echo "check-network: nothing to check"
  exit 0
fi

FILES=()
while IFS= read -r -d '' f; do
  case "$f" in
    *.test.ts | *.spec.ts) continue ;;
    web/src/tests/*) continue ;;
    mac/Tests/*) continue ;;
  esac
  FILES+=("$f")
done < <(find "${SCAN_DIRS[@]}" -type f \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.swift' \) \
  -print0)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "check-network: nothing to check"
  exit 0
fi

FAIL=0

ALWAYS_BANNED='WebSocket|RTCPeerConnection|sendBeacon|EventSource|XMLHttpRequest'

for f in "${FILES[@]}"; do
  while IFS=: read -r lineno content; do
    trimmed="$(sed -e 's/^[[:space:]]*//' <<<"$content")"
    echo "$f:$lineno: forbidden network primitive outside net.ts: $trimmed"
    FAIL=1
  done < <(grep -nE "$ALWAYS_BANNED" "$f" || true)

  case "$f" in
    web/src/main.ts*) ;;
    *)
      while IFS=: read -r lineno content; do
        trimmed="$(sed -e 's/^[[:space:]]*//' <<<"$content")"
        echo "$f:$lineno: navigator.serviceWorker.register outside web/src/main.ts*: $trimmed"
        FAIL=1
      done < <(grep -nF 'navigator.serviceWorker.register' "$f" || true)
      ;;
  esac

  case "$f" in
    web/src/engine/net.ts | mac/Sources/FruitbatCore/NetworkPolicy.swift) ;;
    *)
      while IFS=: read -r lineno content; do
        trimmed="$(sed -e 's/^[[:space:]]*//' <<<"$content")"
        # a mention inside a comment line is not a call (Codex review, PR #11)
        case "$trimmed" in //*|\**|/\**) continue ;; esac
        echo "$f:$lineno: raw fetch() outside web/src/engine/net.ts: $trimmed"
        FAIL=1
      done < <(grep -nE 'fetch[[:space:]]*\(' "$f" || true)
      ;;
  esac

  case "$f" in
    *.swift)
      case "$f" in
        mac/Sources/FruitbatCore/NetworkPolicy.swift) ;;
        *)
          while IFS=: read -r lineno content; do
            trimmed="$(sed -e 's/^[[:space:]]*//' <<<"$content")"
            echo "$f:$lineno: raw URLSession outside NetworkPolicy.swift: $trimmed"
            FAIL=1
          done < <(grep -nE 'URLSession\.shared|URLSession\(configuration' "$f" || true)
          ;;
      esac
      ;;
  esac
done

if [ "$FAIL" -eq 1 ]; then
  exit 1
fi

echo "check-network: OK (${#FILES[@]} files)"
exit 0
