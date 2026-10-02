#!/usr/bin/env bash
# Deploy exactly what is pushed to origin/main, from a clean worktree, so in-progress local
# edits (other agents, uncommitted work) never ship. Secrets are already set on the Worker.
#
#   scripts/deploy-clean.sh [worktree-dir] [--skip-tests]
#
# Gate: `pnpm -r typecheck` and the platform test suite must pass on the exact commit being
# deployed (a store bug that only showed up in workerd tests once reached production because
# deploys only typechecked). `--skip-tests` exists for emergencies only — say why in the commit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${TMPDIR:-/tmp}/gittifacts-deploy"
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    *) DIR="$arg" ;;
  esac
done

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
# Build what the tests and the deploy both need (web assets, templates, sandbox bundle).
CI=1 pnpm run deploy:prepare
if [ "$SKIP_TESTS" -eq 0 ]; then
  echo "gate: typecheck"
  (cd "$DIR" && pnpm -r typecheck)
  echo "gate: platform tests"
  CI=1 pnpm exec vitest run --maxWorkers=2
else
  echo "WARNING: --skip-tests: deploying without the test gate"
fi
CI=1 pnpm exec wrangler d1 migrations apply DB --remote
CI=1 pnpm exec wrangler deploy
