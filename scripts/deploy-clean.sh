#!/usr/bin/env bash
# Deploy exactly what is pushed to origin/main, from a clean worktree, so in-progress local
# edits (other agents, uncommitted work) never ship. Secrets are already set on the Worker.
#
#   scripts/deploy-clean.sh [worktree-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${1:-${TMPDIR:-/tmp}/gittifacts-deploy}"

git -C "$ROOT" fetch -q origin
if [ -d "$DIR/.git" ] || [ -f "$DIR/.git" ]; then
  git -C "$DIR" checkout -q --detach origin/main
else
  git -C "$ROOT" worktree prune
  git -C "$ROOT" worktree add -q --detach "$DIR" origin/main
fi
echo "deploying $(git -C "$DIR" log --oneline -1)"

cd "$DIR"
pnpm install --frozen-lockfile --reporter=silent
cd apps/platform
CI=1 pnpm exec wrangler d1 migrations apply DB --remote
CI=1 pnpm run deploy
