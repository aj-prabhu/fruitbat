#!/usr/bin/env bash
# scripts/release-check.sh <commit>  (docs/PLAN.md rule 10, QA plan)
#
# The single dependency of every release and of the live gate (S1-16). Runs every check the
# QA-plan paragraph lists against <commit>, prints a `check | status | detail` table, and exits
# non-zero if any row is FAIL. Infra that hasn't landed yet prints `missing (<packet>)`, which is
# a FAIL unless RELEASE_CHECK_ALLOW_MISSING=1 (local dry runs only — downgrades `missing` rows to
# `skipped` and prints a loud banner).
#
#   TAG=web-v1.2.3 scripts/release-check.sh <commit>   # release: checks tag <-> spec/version.json
#   scripts/release-check.sh <commit>                  # dry run: no tag to check against
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMMIT="${1:-}"
[ -z "$COMMIT" ] && { echo "usage: $0 <commit>" >&2; exit 2; }
COMMIT_FULL="$(git rev-parse "$COMMIT")"
ALLOW_MISSING="${RELEASE_CHECK_ALLOW_MISSING:-}"
if [ "$ALLOW_MISSING" = "1" ]; then
  echo "### RELEASE_CHECK_ALLOW_MISSING=1 — missing infra counts as skipped, not FAIL. Dry runs only. ###"
fi

ROWS=()
FAILED=0
# row NAME STATUS DETAIL — records a row. Always returns 0: under `set -e`, a plain (non-if/&&)
# call to a function whose last command fails would otherwise abort the whole script.
row() {
  ROWS+=("$1|$2|$3")
  if [ "$2" = "FAIL" ]; then FAILED=1; fi
  return 0
}
# missing NAME PACKET DETAIL — infra that doesn't exist yet: FAIL unless RELEASE_CHECK_ALLOW_MISSING=1.
missing() {
  if [ "$ALLOW_MISSING" = "1" ]; then row "$1" SKIPPED "missing ($2): $3"; else row "$1" FAIL "missing ($2): $3"; fi
  return 0
}
# run_check NAME LOGFILE CMD... — runs CMD, records PASS/FAIL pointing at LOGFILE.
run_check() {
  local name="$1" log="$2"
  shift 2
  if "$@" >"$log" 2>&1; then row "$name" PASS "$*"; else row "$name" FAIL "see $log"; fi
  return 0
}

# (a) commit is an ancestor of main, or equals HEAD (checks local main, falls back to origin/main
# for a CI checkout that never creates a local main branch)
HEAD_FULL="$(git rev-parse HEAD)"
MAIN_REF=""
if git rev-parse --verify -q main >/dev/null; then MAIN_REF=main
elif git rev-parse --verify -q origin/main >/dev/null; then MAIN_REF=origin/main
fi
if [ "$COMMIT_FULL" = "$HEAD_FULL" ]; then
  row commit-ancestor PASS "commit equals HEAD"
elif [ -n "$MAIN_REF" ] && git merge-base --is-ancestor "$COMMIT_FULL" "$MAIN_REF" 2>/dev/null; then
  row commit-ancestor PASS "commit is an ancestor of $MAIN_REF"
else
  row commit-ancestor FAIL "$COMMIT_FULL is neither HEAD nor an ancestor of ${MAIN_REF:-main}"
fi

# (b) spec/version.json web version not 0.0.0, and matches TAG when TAG is a web-v* tag
WEB_VERSION="$(jq -r '.web' spec/version.json)"
if [ "$WEB_VERSION" = "0.0.0" ]; then
  row version FAIL "spec/version.json web version is still 0.0.0"
elif [[ "${TAG:-}" == web-v* ]]; then
  TAG_VERSION="${TAG#web-v}"
  TAG_VERSION="${TAG_VERSION%-test}"
  if [ "$TAG_VERSION" = "$WEB_VERSION" ]; then
    row version PASS "$TAG <-> web $WEB_VERSION"
  else
    row version FAIL "$TAG expects web $TAG_VERSION, spec/version.json has $WEB_VERSION"
  fi
else
  row version PASS "web $WEB_VERSION"
fi

# (c) CHANGELOG.md has a section for that version
CHANGELOG_VERSION="$WEB_VERSION"
if [[ "${TAG:-}" == web-v* ]]; then
  CHANGELOG_VERSION="${TAG#web-v}"
  CHANGELOG_VERSION="${CHANGELOG_VERSION%-test}"
elif [[ "${TAG:-}" == mac-v* ]]; then
  CHANGELOG_VERSION="$(jq -r '.mac' spec/version.json)"
fi
if grep -qE "^## \[$CHANGELOG_VERSION\]" CHANGELOG.md; then
  row changelog PASS "## [$CHANGELOG_VERSION] present"
else
  row changelog FAIL "no '## [$CHANGELOG_VERSION]' section in CHANGELOG.md"
fi

# (d) web/: npm ci && npm run build && npm test (skip npm test with a row if no test script)
if (cd web && npm ci --no-fund --no-audit && npm run build) >/tmp/release-check-web-build.log 2>&1; then
  row web-build PASS "npm ci && npm run build"
else
  row web-build FAIL "see /tmp/release-check-web-build.log"
fi
if jq -e '.scripts.test' web/package.json >/dev/null 2>&1; then
  if (cd web && npm test) >/tmp/release-check-web-test.log 2>&1; then
    row web-test PASS "npm test"
  else
    row web-test FAIL "see /tmp/release-check-web-test.log"
  fi
else
  row web-test SKIPPED "no test script in web/package.json"
fi

# (e) npx playwright test --project=wasm-ci (skip with a row if browsers aren't installed)
PW_LOG=/tmp/release-check-playwright.log
if (cd web && npx --yes playwright test --project=wasm-ci) >"$PW_LOG" 2>&1; then
  row playwright-wasm-ci PASS "wasm-ci project green"
elif grep -qiE "executable doesn't exist|playwright install" "$PW_LOG"; then
  STATUS=FAIL
  [ "$ALLOW_MISSING" = "1" ] && STATUS=SKIPPED
  row playwright-wasm-ci "$STATUS" "Playwright browsers not installed (run: npx playwright install)"
else
  row playwright-wasm-ci FAIL "see $PW_LOG"
fi

# (f) scripts/check-logs.sh and scripts/check-network.sh, if present
for name in check-logs check-network; do
  script="scripts/$name.sh"
  if [ -x "$script" ]; then
    run_check "$name" "/tmp/release-check-$name.log" "$script"
  else
    missing "$name" S0-02 "$script"
  fi
done

# (g) gitleaks detect, if installed
if command -v gitleaks >/dev/null 2>&1; then
  run_check gitleaks /tmp/release-check-gitleaks.log gitleaks detect --source "$ROOT" --no-git -v
else
  row gitleaks FAIL "missing: gitleaks not installed (brew install gitleaks)"
fi

# (h) bench rows valid for the commit, or a hand-filled gate file (cut list)
if [ -n "${RELEASE_GATE_FILE:-}" ]; then
  if [ -s "$RELEASE_GATE_FILE" ]; then
    row bench-gate PASS "hand-filled gate file: $RELEASE_GATE_FILE"
  else
    row bench-gate FAIL "RELEASE_GATE_FILE=$RELEASE_GATE_FILE missing or empty"
  fi
elif [ -f bench/gate.py ]; then
  run_check bench-gate /tmp/release-check-bench-gate.log python3 bench/gate.py --release --commit "$COMMIT_FULL"
else
  missing bench-gate S0-05 "bench/gate.py"
fi

# (i) graded files: bench/graded/<commit>-*.json count >= 18, every score >= 4
if [ -d bench/graded ]; then
  GRADED_FILES=(bench/graded/"${COMMIT_FULL}"-*.json)
  if [ -e "${GRADED_FILES[0]}" ]; then
    COUNT=${#GRADED_FILES[@]}
    LOW="$(jq -s 'map(select(.score < 4)) | length' "${GRADED_FILES[@]}")"
    if [ "$COUNT" -ge 18 ] && [ "$LOW" -eq 0 ]; then
      row graded PASS "$COUNT files, all scores >= 4"
    else
      row graded FAIL "$COUNT files (need >= 18), $LOW below score 4"
    fi
  else
    row graded FAIL "no bench/graded/$COMMIT_FULL-*.json files"
  fi
else
  missing graded S1-14 "bench/graded/"
fi

# (j) node scripts/strings-check.mjs, if present
if [ -f scripts/strings-check.mjs ]; then
  run_check strings-check /tmp/release-check-strings.log node scripts/strings-check.mjs
else
  missing strings-check S1-L0 "scripts/strings-check.mjs"
fi

# (k) docs/qa/privacy-requests-<commit>.json exists and is non-empty
PRIVACY_FILE="docs/qa/privacy-requests-${COMMIT_FULL}.json"
if [ -s "$PRIVACY_FILE" ]; then
  row privacy-requests PASS "$PRIVACY_FILE"
else
  missing privacy-requests S1-12 "$PRIVACY_FILE"
fi

# --- print the table ---
printf "\n%-20s %-9s %s\n" check status detail
printf "%-20s %-9s %s\n" "--------------------" "---------" "-------"
for r in "${ROWS[@]}"; do
  IFS='|' read -r name status detail <<<"$r"
  printf "%-20s %-9s %s\n" "$name" "$status" "$detail"
done
echo

if [ "$FAILED" -eq 1 ]; then
  echo "release-check: FAIL"
  exit 1
fi
echo "release-check: PASS"
