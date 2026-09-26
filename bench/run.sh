#!/usr/bin/env bash
# bench/run.sh -- the one entry point for driving a bench run (docs/PLAN.md rule 3, packet
# S1-13). Dispatches on --target; today only "web" has a runner (bench/web/run.mjs). "mac" is
# S2-13's job and isn't built yet.
#
# Usage:
#   bench/run.sh --target web [--docs N|id,id,...] [--levels all|level,level,...] \
#                [--cache warm|cold] [--reps N] [--port PORT]
#   bench/run.sh --target mac   # prints "S2-13" and exits 2 (not built yet)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

target=""
pass_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      target="${2:-}"
      shift 2
      ;;
    *)
      pass_args+=("$1")
      shift
      ;;
  esac
done

if [[ "$target" == "mac" ]]; then
  echo "S2-13"
  exit 2
fi

if [[ "$target" != "web" ]]; then
  echo "bench/run.sh: --target must be 'web' or 'mac' (got '${target:-<empty>}')" >&2
  exit 2
fi

# ${arr[@]+...}: macOS's Bash 3.2 treats an empty array as unbound under `set -u` (Codex review, PR #27).
exec node "$HERE/web/run.mjs" ${pass_args[@]+"${pass_args[@]}"}
