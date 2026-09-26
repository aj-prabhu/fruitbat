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
# ^{commit} peels an annotated tag to the commit it points at (Codex review, PR #6).
COMMIT_FULL="$(git rev-parse --verify "$COMMIT^{commit}")"
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
  if "$@" >"$log" 2>&1; then
    row "$name" PASS "$*"
  else
    row "$name" FAIL "see $log (tail printed above)"
    # The CI runner is discarded after the job, so the reason goes into the job log too (Codex review, PR #6).
    { echo "---- $name FAILED: last 40 lines of $log ----"; tail -n 40 "$log"; echo "----"; } >&2
  fi
  return 0
}

# (a) the commit must be checked out: every check below runs against the working tree, so a
# commit that is not HEAD would be checked against the wrong files (Codex review, PR #6).
HEAD_FULL="$(git rev-parse HEAD)"
if [ "$COMMIT_FULL" = "$HEAD_FULL" ]; then
  row commit-checked-out PASS "commit equals HEAD"
else
  row commit-checked-out FAIL "$COMMIT_FULL is not HEAD ($HEAD_FULL); check it out first"
fi
# ...and clean: staged, unstaged or untracked changes would be tested instead of the commit
# (Codex review, PR #6).
DIRTY="$(git status --porcelain)"
if [ -z "$DIRTY" ]; then
  row clean-checkout PASS "no local changes"
else
  row clean-checkout FAIL "working tree has changes: $(echo "$DIRTY" | head -3 | tr '\n' ' ')"
fi

# Evidence files (bench rows, graded files, the privacy request log) are committed on top of the
# commit they describe, so they are named by an earlier SHA. A file's evidence is valid for
# COMMIT when its SHA is an ancestor of COMMIT and nothing but evidence files changed since
# (docs/PLAN.md rule 3; Codex review, PR #6).
EVIDENCE_PATHSPEC=(. ':!bench/results.csv' ':!bench/baselines.json' ':!bench/graded/*' ':!bench/release-gate-*.md' ':!docs/qa/privacy-requests-*.json')
evidence_valid() {
  local sha="$1"
  git rev-parse --verify -q "$sha^{commit}" >/dev/null 2>&1 || return 1
  git merge-base --is-ancestor "$sha" "$COMMIT_FULL" 2>/dev/null || return 1
  git diff --quiet "$sha" "$COMMIT_FULL" -- "${EVIDENCE_PATHSPEC[@]}"
}

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

# (h) bench rows valid for the commit (gate.py applies the same evidence rule), or a hand-filled gate file (cut list)
if [ -n "${RELEASE_GATE_FILE:-}" ]; then
  # A hand-filled gate stands in for bench rows only if it is finished and passing: a
  # "commit: <sha>" line naming the code commit it measured, which must be valid evidence for this
  # commit (the gate file is itself evidence, committed on top), a "verdict: PASS" line, and no
  # FAIL verdict (docs/release.md; Codex review, PR #6).
  GATE_COMMIT="$(sed -n 's/^commit:[[:space:]]*\([0-9a-f]\{7,40\}\)[[:space:]]*$/\1/p' "$RELEASE_GATE_FILE" 2>/dev/null | head -1)"
  if [ ! -s "$RELEASE_GATE_FILE" ]; then
    row bench-gate FAIL "RELEASE_GATE_FILE=$RELEASE_GATE_FILE missing or empty"
  elif [ -z "$GATE_COMMIT" ] || ! evidence_valid "$GATE_COMMIT"; then
    row bench-gate FAIL "$RELEASE_GATE_FILE: no 'commit: <sha>' line whose sha is valid evidence for $COMMIT_FULL"
  elif grep -qiE '^verdict:[[:space:]]*FAIL' "$RELEASE_GATE_FILE" || ! grep -qE '^verdict:[[:space:]]*PASS[[:space:]]*$' "$RELEASE_GATE_FILE"; then
    row bench-gate FAIL "$RELEASE_GATE_FILE: needs 'verdict: PASS' and no FAIL verdict"
  else
    row bench-gate PASS "hand-filled gate file: $RELEASE_GATE_FILE (commit $GATE_COMMIT, verdict PASS)"
  fi
elif [ -f bench/gate.py ]; then
  run_check bench-gate /tmp/release-check-bench-gate.log python3 bench/gate.py --release --commit "$COMMIT_FULL"
else
  missing bench-gate S0-05 "bench/gate.py"
fi

# (i) graded files: bench/graded/<sha>-<doc>-<level>.json for a sha whose evidence is valid for
# COMMIT, one for every doc in the manifest's graded_set x {short, caveman, oneline} (18), each a
# JSON object whose doc/level/commit match its name and whose numeric score is >= 4. Counting
# files is not enough: empty or unrelated files must not pass (Codex review, PR #6).
if [ -d bench/graded ]; then
  GRADED_DOCS="$(jq -r '.graded_set[]' spec/eval/manifest.json)"
  # graded_problems SHA: prints one line per missing or invalid file of SHA's full matrix.
  graded_problems() {
    local sha="$1" doc level f
    for doc in $GRADED_DOCS; do
      for level in short caveman oneline; do
        f="bench/graded/${sha}-${doc}-${level}.json"
        if [ ! -s "$f" ]; then echo "$doc/$level missing"; continue; fi
        jq -e --arg d "$doc" --arg l "$level" --arg s "$sha" \
          '(type == "object") and (.doc == $d) and (.level == $l)
           and ((.commit | tostring) as $c | (($c | length) >= 7) and (($c | startswith($s)) or ($s | startswith($c))))
           and ((.score | type) == "number") and (.score >= 4)' "$f" >/dev/null 2>&1 \
          || echo "$doc/$level invalid or score < 4"
      done
    done
  }
  NEED=$(( $(echo "$GRADED_DOCS" | grep -c .) * 3 ))
  # Candidate SHAs with valid evidence, newest first by ancestry depth (every candidate is an
  # ancestor of COMMIT, so the deepest is the latest; timestamps can tie). The newest one
  # decides: a failing or incomplete re-grade is not hidden by an older passing set (Codex review, PR #6).
  CANDIDATES="$(for f in bench/graded/*-*.json; do [ -e "$f" ] && basename "$f" | cut -d- -f1; done | sort -u \
    | while read -r sha; do evidence_valid "$sha" && echo "$(git rev-list --count "$sha" 2>/dev/null || echo 0) $sha"; done \
    | sort -rn | cut -d' ' -f2)" || true # an empty glob or no valid sha is an empty list, not an exit
  GRADED_SHA=""
  PROBLEMS=""
  NEWEST="$(echo "$CANDIDATES" | head -1)"
  if [ -n "$NEWEST" ]; then
    p="$(graded_problems "$NEWEST")"
    if [ -z "$p" ]; then GRADED_SHA="$NEWEST"; else PROBLEMS="$NEWEST: $(echo "$p" | head -5 | tr '\n' ';')"; fi
  fi
  if [ -n "$CANDIDATES" ]; then
    if [ -n "$GRADED_SHA" ] && [ "$NEED" -ge 18 ]; then
      row graded PASS "$NEED graded files for $GRADED_SHA (evidence valid for $COMMIT_FULL), all scores >= 4"
    else
      row graded FAIL "need $NEED (graded_set x 3 levels, >= 18) for one sha; newest candidate ${PROBLEMS:-graded_set too small}"
    fi
  else
    row graded FAIL "no bench/graded/<sha>-*.json whose sha is valid evidence for $COMMIT_FULL"
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

# (k) docs/qa/privacy-requests-<sha>.json, non-empty, for a sha whose evidence is valid for COMMIT
# The log must be the object privacy.spec.ts writes, for its own commit, with at least one
# recorded request; "[]", "{}" or broken JSON is not evidence (Codex review, PR #6).
privacy_log_ok() {
  jq -e --arg s "$2" '(type == "object")
    and ((.commit | tostring) as $c | (($c | length) >= 7) and (($c | startswith($s)) or ($s | startswith($c))))
    and ((.records | type) == "array") and ((.records | length) > 0)
    and (.requestCount == (.records | length))' "$1" >/dev/null 2>&1
}
PRIVACY_FILE=""
for f in docs/qa/privacy-requests-*.json; do
  [ -s "$f" ] || continue
  sha="$(basename "$f" .json)"; sha="${sha#privacy-requests-}"
  if evidence_valid "$sha" && privacy_log_ok "$f" "$sha"; then PRIVACY_FILE="$f"; fi
done
if [ -n "$PRIVACY_FILE" ]; then
  row privacy-requests PASS "$PRIVACY_FILE (evidence valid for $COMMIT_FULL)"
elif ls docs/qa/privacy-requests-*.json >/dev/null 2>&1; then
  row privacy-requests FAIL "no well-formed docs/qa/privacy-requests-<sha>.json whose sha is valid evidence for $COMMIT_FULL"
else
  missing privacy-requests S1-12 "docs/qa/privacy-requests-<sha>.json"
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
