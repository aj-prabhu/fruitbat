#!/usr/bin/env bash
# scripts/health-check.sh (docs/PLAN.md S0-06)
#
# Weekly (and on-demand) health sweep, run by .github/workflows/health.yml. Prints a
# `check | status | detail` table (same shape as release-check.sh) and exits non-zero on any
# FAIL. Checks:
#   (a) web/: npm ci && npm run build
#   (b) every model file URL in spec/models.json (web.summarizer, web.voice, and any
#       web.summarizer_fallbacks[]) answers 200 after redirects. Read at run time, not hardcoded,
#       so S0-03's fallback tiers are picked up automatically once that branch merges.
#   (c) npm audit --audit-level=high in web/ (FAIL on high/critical)
#   (d) the public and dev Spaces respond 200
#   (e) Playwright WASM smoke against the public Space (tests/skeleton.spec.ts, wasm-ci project)
#
# HEALTH_SKIP_SPACE=1 skips (d) and (e) with SKIPPED rows. The public Space
# (https://2shay-fruitbat.static.hf.space/) is private until the web-v0.1.0 tag (docs/PLAN.md
# rule 10), so it 401s today — use HEALTH_SKIP_SPACE=1 until that tag ships.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_SPACE="${HEALTH_SKIP_SPACE:-}"
PUBLIC_SPACE_URL="https://2shay-fruitbat.static.hf.space/"
DEV_SPACE_URL="https://2shay-fruitbat-dev.static.hf.space/"

ROWS=()
FAILED=0
# row NAME STATUS DETAIL — records a row. Always returns 0: under `set -e`, a plain (non-if/&&)
# call to a function whose last command fails would otherwise abort the whole script.
row() {
  ROWS+=("$1|$2|$3")
  if [ "$2" = "FAIL" ]; then FAILED=1; fi
  return 0
}

# (a) web/: npm ci && npm run build
WEB_BUILD_LOG=/tmp/health-check-web-build.log
if (cd web && npm ci && npm run build) >"$WEB_BUILD_LOG" 2>&1; then
  row web-build PASS "npm ci && npm run build"
else
  row web-build FAIL "see $WEB_BUILD_LOG"
fi

# (b) every model file URL from spec/models.json (web target, all tiers): HEAD after redirects.
# Read whatever spec/models.json says right now — summarizer, voice, and any fallback tiers —
# so this never needs updating when S0-03 adds more models.
if [ -f spec/models.json ]; then
  MODEL_ROWS="$(jq -r '
    .web as $w
    | ([$w.summarizer, $w.voice] + ($w.summarizer_fallbacks // []))
    | .[]
    | select(. != null)
    | . as $m
    | $m.files[]?
    | [$m.role // "default", $m.id, $m.revision, $m.url_template, .path] | @tsv
  ' spec/models.json)"
  if [ -z "$MODEL_ROWS" ]; then
    row model-urls FAIL "spec/models.json produced no files[] under web.summarizer/voice/summarizer_fallbacks"
  else
    while IFS=$'\t' read -r role id revision url_template path; do
      [ -z "$id" ] && continue
      url="${url_template//\{id\}/$id}"
      url="${url//\{revision\}/$revision}"
      url="${url//\{path\}/$path}"
      code="$(curl -sIL -o /dev/null -w '%{http_code}' "$url" || echo "000")"
      if [ "$code" = "200" ]; then
        row "model:$role:$id:$path" PASS "$code $url"
      else
        row "model:$role:$id:$path" FAIL "$code $url"
      fi
    done <<<"$MODEL_ROWS"
  fi
else
  row model-urls FAIL "spec/models.json not found"
fi

# (c) npm audit --audit-level=high in web/ (FAIL on high/critical)
AUDIT_LOG=/tmp/health-check-npm-audit.log
if (cd web && npm audit --audit-level=high) >"$AUDIT_LOG" 2>&1; then
  row npm-audit PASS "no high/critical advisories"
else
  row npm-audit FAIL "see $AUDIT_LOG"
fi

# (d) the public and dev Spaces respond 200
if [ "$SKIP_SPACE" = "1" ]; then
  row space-public SKIPPED "HEALTH_SKIP_SPACE=1 (public Space is private until web-v0.1.0)"
  row space-dev SKIPPED "HEALTH_SKIP_SPACE=1"
else
  PUBLIC_CODE="$(curl -sL -o /dev/null -w '%{http_code}' "$PUBLIC_SPACE_URL" || echo "000")"
  if [ "$PUBLIC_CODE" = "200" ]; then
    row space-public PASS "$PUBLIC_CODE $PUBLIC_SPACE_URL"
  else
    row space-public FAIL "$PUBLIC_CODE $PUBLIC_SPACE_URL"
  fi
  DEV_CODE="$(curl -sL -o /dev/null -w '%{http_code}' "$DEV_SPACE_URL" || echo "000")"
  if [ "$DEV_CODE" = "200" ]; then
    row space-dev PASS "$DEV_CODE $DEV_SPACE_URL"
  else
    row space-dev FAIL "$DEV_CODE $DEV_SPACE_URL"
  fi
fi

# (e) Playwright WASM smoke against the public Space. tests/skeleton.spec.ts on wasm-ci only runs
# the cross-origin-isolation test today; the real-text/real-audio test skips on wasm-ci (S1-05's
# ?llm=fake worker doesn't exist yet), so this is an isolation smoke, not the full "Read all on 50
# words produces audio within 120s" check from docs/PLAN.md v3 — that needs S1-05/S1-06 first.
if [ "$SKIP_SPACE" = "1" ]; then
  row space-smoke-wasm SKIPPED "HEALTH_SKIP_SPACE=1"
else
  SMOKE_LOG=/tmp/health-check-playwright-smoke.log
  if (cd web && BASE_URL="$PUBLIC_SPACE_URL" npx playwright test tests/skeleton.spec.ts --project=wasm-ci) >"$SMOKE_LOG" 2>&1; then
    row space-smoke-wasm PASS "wasm-ci isolation test green against $PUBLIC_SPACE_URL"
  else
    row space-smoke-wasm FAIL "see $SMOKE_LOG"
  fi
fi

# --- print the table ---
printf "\n%-45s %-9s %s\n" check status detail
printf "%-45s %-9s %s\n" "---------------------------------------------" "---------" "-------"
for r in "${ROWS[@]}"; do
  IFS='|' read -r name status detail <<<"$r"
  printf "%-45s %-9s %s\n" "$name" "$status" "$detail"
done
echo

if [ "$FAILED" -eq 1 ]; then
  echo "health-check: FAIL"
  exit 1
fi
echo "health-check: PASS"
