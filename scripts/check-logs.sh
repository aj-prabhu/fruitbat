#!/usr/bin/env bash
# check-logs.sh — fail if anything outside the logger module logs directly.
#
# Scope: web/src/ and mac/Sources/ only. Skips cleanly if neither exists.
# Excludes: test files, the logger modules themselves, web/src/vendor/.
#
# Fails on: console.log/info/debug/warn/error(, print(, debugPrint(, NSLog(,
# and os_log()/Logger() calls whose argument uses Swift string interpolation \(.
set -euo pipefail

SCAN_DIRS=()
[ -d web/src ] && SCAN_DIRS+=(web/src)
[ -d mac/Sources ] && SCAN_DIRS+=(mac/Sources)

if [ ${#SCAN_DIRS[@]} -eq 0 ]; then
  echo "check-logs: nothing to check"
  exit 0
fi

FILES=()
while IFS= read -r -d '' f; do
  case "$f" in
    *.test.ts | *.spec.ts) continue ;;
    web/src/tests/*) continue ;;
    mac/Tests/*) continue ;;
    web/src/engine/log.ts) continue ;;
    mac/Sources/FruitbatCore/Log.swift) continue ;;
    web/src/vendor/*) continue ;;
  esac
  FILES+=("$f")
done < <(find "${SCAN_DIRS[@]}" -type f \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.swift' \) \
  -print0)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "check-logs: nothing to check"
  exit 0
fi

FAIL=0

SIMPLE_PATTERN='console\.log\(|console\.info\(|console\.debug\(|console\.warn\(|console\.error\(|print\(|debugPrint\(|NSLog\('

for f in "${FILES[@]}"; do
  while IFS=: read -r lineno content; do
    trimmed="$(sed -e 's/^[[:space:]]*//' <<<"$content")"
    echo "$f:$lineno: forbidden logging call: $trimmed"
    FAIL=1
  done < <(grep -nE "$SIMPLE_PATTERN" "$f" || true)

  # os_log() / Logger() calls that use Swift string interpolation (\() are
  # a leak risk: the interpolated value could be source text.
  while IFS=: read -r lineno content; do
    if grep -qF '\(' <<<"$content"; then
      trimmed="$(sed -e 's/^[[:space:]]*//' <<<"$content")"
      echo "$f:$lineno: forbidden logging call with string interpolation: $trimmed"
      FAIL=1
    fi
  done < <(grep -nE 'os_log\(|Logger\(' "$f" || true)
done

if [ "$FAIL" -eq 1 ]; then
  exit 1
fi

echo "check-logs: OK (${#FILES[@]} files)"
exit 0
