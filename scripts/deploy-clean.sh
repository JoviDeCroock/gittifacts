#!/usr/bin/env bash
# Deploy exactly what is pushed to origin/main, from a clean worktree, so in-progress local
# edits (other agents, uncommitted work) never ship. Secrets are already set on the Worker.
#
#   scripts/deploy-clean.sh [worktree-dir] [--gate=local|ci] [--smoke=ci|local|off] [--staging] [--skip-tests]
#
# Gate: `pnpm -r typecheck` and the platform test suite must pass on the exact commit being
# deployed (a store bug that only showed up in workerd tests once reached production because
# deploys only typechecked).
#   --gate=local (default) runs them here.
#   --gate=ci dispatches .github/workflows/deploy-gate.yml for the commit, waits, and deploys only
#     if it succeeded (use it when this machine is too loaded to run the suite).
#   --skip-tests exists for emergencies only — say why in the commit/DECISIONS.
#
# After `wrangler deploy` (tagged with the commit, so /api/v1/health names it), the post-deploy
# smoke runs against the live URL (docs/testing.md, tier 2):
#   --smoke=ci (default) dispatches .github/workflows/post-deploy-smoke.yml and waits;
#   --smoke=local runs the same suite here; --smoke=off skips it (say why).
# A failed smoke rolls back to the version that was live before this deploy (scripts/rollback.sh:
# the workflow does it when it has CLOUDFLARE_API_TOKEN, else this script with your wrangler login)
# and exits 1.
#
# --staging (docs/testing.md, "Staging"): deploy the same commit to the gittifacts-staging Worker
# (its migrations first) and pass the smoke there before touching production.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${TMPDIR:-/tmp}/gittifacts-deploy"
GATE=local
SMOKE=ci
STAGING=0
SKIP_TESTS=0
URL="https://gittifacts.decroockjovi.workers.dev"
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --gate=local) GATE=local ;;
    --gate=ci) GATE=ci ;;
    --smoke=ci) SMOKE=ci ;;
    --smoke=local) SMOKE=local ;;
    --smoke=off) SMOKE=off ;;
    --staging) STAGING=1 ;;
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

# Dispatch a workflow on main and wait for THE run it started (the first dispatch created after
# this call, not whatever ran last). Prints the run URL; returns the run's exit status.
dispatch_and_watch() {
  local workflow="$1"; shift
  # 30 s of slack for clock skew between this machine and GitHub.
  local since; since="$(node -e 'console.log(new Date(Date.now()-30000).toISOString().slice(0,19)+"Z")')"
  gh workflow run "$workflow" --ref main "$@" >/dev/null
  local id=""
  for _ in $(seq 1 30); do
    sleep 5
    id="$(gh run list --workflow "$workflow" --event workflow_dispatch --limit 10 --json databaseId,createdAt \
      --jq "[.[] | select(.createdAt >= \"$since\")] | sort_by(.createdAt) | .[0].databaseId // empty" 2>/dev/null || true)"
    [ -n "$id" ] && break
  done
  [ -n "$id" ] || { echo "$workflow: could not find the dispatched run"; return 1; }
  echo "$workflow: run $(gh run view "$id" --json url --jq .url)"
  gh run watch "$id" --exit-status --interval 20 >/dev/null
}

ci_gate() {
  echo "gate: ci (deploy-gate.yml @ $SHA)"
  if ! dispatch_and_watch deploy-gate.yml -f sha="$SHA"; then
    echo "gate: FAILED"
    exit 1
  fi
  echo "gate: passed"
}

live_version_id() {
  (cd "$DIR/apps/platform" && CI=1 pnpm exec wrangler deployments status --json 2>/dev/null) |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=[...j.versions].sort((a,b)=>b.percentage-a.percentage)[0];console.log(v?v.version_id:"")}catch{console.log("")}})'
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
# The container images build locally, and Docker Desktop on this shared machine sometimes quits
# mid-session: start it if needed and wait for the daemon instead of failing the deploy.
if ! docker info >/dev/null 2>&1; then
  echo "docker: not running, starting Docker Desktop"
  open -a Docker 2>/dev/null || true
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 5; done
  docker info >/dev/null 2>&1 || { echo "docker: still not running after 5 min"; exit 1; }
fi
TAG="${SHA:0:12}"
if [ "$STAGING" -eq 1 ]; then
  "$DIR/scripts/staging/deploy.sh" "$DIR" "$TAG" "--smoke=$SMOKE" || { echo "staging: FAILED, production not deployed"; exit 1; }
fi
# Production's migrations only once staging (same migrations, real D1) took them and passed.
CI=1 pnpm exec wrangler d1 migrations apply DB --remote
PREVIOUS="$(live_version_id)"
echo "deploy: live before = ${PREVIOUS:-unknown}"
CI=1 pnpm exec wrangler deploy --tag "$TAG" --message "deploy-clean $TAG"
DEPLOYED="$(live_version_id)"
echo "deploy: live now = ${DEPLOYED:-unknown} (tag $TAG)"

smoke_failed() {
  echo "smoke: FAILED for $TAG"
  if [ -n "$PREVIOUS" ] && [ -n "$DEPLOYED" ] && [ "$PREVIOUS" != "$DEPLOYED" ]; then
    # A no-op when the workflow already rolled back (the previous version is live again).
    "$DIR/scripts/rollback.sh" --url "$URL" --deployed "$DEPLOYED" --to "$PREVIOUS" \
      --reason "post-deploy smoke failed for $TAG" || echo "smoke: ROLLBACK FAILED, roll back by hand: wrangler rollback $PREVIOUS"
  else
    echo "smoke: no previous version known, nothing rolled back"
  fi
  exit 1
}

case "$SMOKE" in
  ci)
    echo "smoke: ci (post-deploy-smoke.yml against $URL)"
    dispatch_and_watch post-deploy-smoke.yml -f url="$URL" -f expect_commit="$TAG" \
      -f deployed_version="$DEPLOYED" -f previous_version="$PREVIOUS" || smoke_failed
    echo "smoke: passed"
    ;;
  local)
    echo "smoke: local (apps/e2e against $URL)"
    (cd "$DIR" && pnpm --filter @app/e2e exec playwright install chromium >/dev/null &&
      SMOKE_BASE_URL="$URL" SMOKE_EXPECT_COMMIT="$TAG" pnpm --filter @app/e2e smoke) || smoke_failed
    echo "smoke: passed"
    ;;
  off) echo "WARNING: --smoke=off: deployed without the post-deploy smoke" ;;
esac
