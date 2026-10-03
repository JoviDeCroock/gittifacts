#!/usr/bin/env bash
# Deploy exactly what is pushed to origin/main, from a clean worktree, so in-progress local
# edits (other agents, uncommitted work) never ship. Secrets are already set on the Worker.
#
#   scripts/deploy-clean.sh [worktree-dir] [--gate=local|ci] [--skip-tests]
#
# Gate: `pnpm -r typecheck` and the platform test suite must pass on the exact commit being
# deployed (a store bug that only showed up in workerd tests once reached production because
# deploys only typechecked).
#   --gate=local (default) runs them here.
#   --gate=ci dispatches .github/workflows/deploy-gate.yml for the commit, waits, and deploys only
#     if it succeeded (use it when this machine is too loaded to run the suite).
#   --skip-tests exists for emergencies only — say why in the commit/DECISIONS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${TMPDIR:-/tmp}/gittifacts-deploy"
GATE=local
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --gate=local) GATE=local ;;
    --gate=ci) GATE=ci ;;
    *) DIR="$arg" ;;
  esac
done

git -C "$ROOT" fetch -q origin
SHA="$(git -C "$ROOT" rev-parse origin/main)"
if [ -d "$DIR/.git" ] || [ -f "$DIR/.git" ]; then
  git -C "$DIR" checkout -q --detach "$SHA"
else
  git -C "$ROOT" worktree prune
  git -C "$ROOT" worktree add -q --detach "$DIR" "$SHA"
fi
echo "deploying $(git -C "$DIR" log --oneline -1)"

ci_gate() {
  echo "gate: ci (deploy-gate.yml @ $SHA)"
  gh workflow run deploy-gate.yml --ref main -f sha="$SHA" >/dev/null
  local id=""
  for _ in $(seq 1 30); do
    sleep 5
    id="$(gh run list --workflow deploy-gate.yml --limit 10 --json databaseId,displayTitle,createdAt,event \
      --jq '[.[] | select(.event == "workflow_dispatch")][0].databaseId' 2>/dev/null || true)"
    [ -n "$id" ] && break
  done
  [ -n "$id" ] || { echo "gate: could not find the dispatched run"; exit 1; }
  echo "gate: run $id"
  if ! gh run watch "$id" --exit-status --interval 30 >/dev/null; then
    echo "gate: FAILED — $(gh run view "$id" --json url --jq .url)"
    exit 1
  fi
  echo "gate: passed"
}

cd "$DIR"
pnpm install --frozen-lockfile --reporter=silent
cd apps/platform
if [ "$SKIP_TESTS" -eq 1 ]; then
  echo "WARNING: --skip-tests: deploying without the test gate"
elif [ "$GATE" = ci ]; then
  ci_gate
fi
# Build what the deploy (and the local gate) needs: web assets, docs, templates, CLI, sandbox.
CI=1 pnpm run deploy:prepare
if [ "$SKIP_TESTS" -eq 0 ] && [ "$GATE" = local ]; then
  echo "gate: typecheck"
  (cd "$DIR" && pnpm -r typecheck)
  echo "gate: platform tests"
  CI=1 pnpm exec vitest run --maxWorkers=2
fi
CI=1 pnpm exec wrangler d1 migrations apply DB --remote
CI=1 pnpm exec wrangler deploy
