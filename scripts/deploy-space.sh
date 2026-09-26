#!/usr/bin/env bash
# Deploy the prebuilt web app to a Hugging Face static Space (docs/PLAN.md C10, rule 10).
#   scripts/deploy-space.sh 2shay/fruitbat-dev            # dev Space, every push to main
#   scripts/deploy-space.sh 2shay/fruitbat --allow-public # public Space, only from release.yml on a web-v* tag
# Needs: node 22, python with huggingface_hub (HF_PY overrides the interpreter), HF_TOKEN env or a
# logged-in hf CLI.
# Uploads dist/* plus web/README.md (the Space front matter). No build on the Hub side.
set -euo pipefail

SPACE="${1:-}"
ALLOW_PUBLIC="${2:-}"
if [ -z "$SPACE" ]; then echo "usage: $0 <owner/space> [--allow-public]" >&2; exit 2; fi
if [ "$SPACE" = "2shay/fruitbat" ] && [ "$ALLOW_PUBLIC" != "--allow-public" ]; then
  echo "refusing to deploy to the public Space without --allow-public (a release is a tag, rule 10)" >&2
  exit 3
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/web"
if [ ! -d node_modules ]; then npm ci --no-fund --no-audit; fi
npm run build

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R dist/. "$STAGE/"
cp README.md "$STAGE/README.md"
rm -rf "$STAGE/.vite"   # build manifest is for the privacy test, not the Space
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

echo "deploy-space: $SPACE <- $(du -sh "$STAGE" | cut -f1) from $COMMIT"
# upload_folder does not try to create the repo (hf upload does, and the create call
# rejects Spaces without an sdk); the Spaces are created once in S1-00b.
HF_PY="${HF_PY:-python3}"
"$HF_PY" - "$SPACE" "$STAGE" "$COMMIT" <<'PY'
import sys
from huggingface_hub import HfApi
space, stage, commit = sys.argv[1:4]
HfApi().upload_folder(repo_id=space, folder_path=stage, repo_type="space",
                      delete_patterns=["*"], commit_message=f"deploy {commit}")
PY
echo "deploy-space: done -> https://huggingface.co/spaces/$SPACE"
