#!/usr/bin/env bash
# Deploy a checkout to the staging Worker and run the post-deploy smoke against it (docs/testing.md,
# "Staging"). scripts/deploy-clean.sh --staging calls it before production; a failure stops the
# production deploy. Needs the resources from scripts/staging/setup.sh and STAGING_D1_ID.
#
#   STAGING_D1_ID=<uuid> scripts/staging/deploy.sh <checkout-dir> <sha12> [--smoke=ci|local]
set -euo pipefail
DIR="${1:?checkout dir}"; TAG="${2:?sha12}"; SMOKE="${3:---smoke=ci}"
[ -n "${STAGING_D1_ID:-}" ] || { echo "staging: STAGING_D1_ID is not set (run scripts/staging/setup.sh first)"; exit 1; }
URL="https://gittifacts-staging.decroockjovi.workers.dev"
cd "$DIR"
CONFIG="$(pnpm exec tsx scripts/staging/config.ts --d1-id "$STAGING_D1_ID")"
cd apps/platform
CI=1 pnpm exec wrangler d1 migrations apply DB --remote --config "$CONFIG"
CI=1 pnpm exec wrangler deploy --config "$CONFIG" --tag "$TAG" --message "staging $TAG"
echo "staging: deployed $TAG to $URL"
cd "$DIR"
case "$SMOKE" in
  --smoke=local)
    SMOKE_BASE_URL="$URL" SMOKE_EXPECT_COMMIT="$TAG" pnpm --filter @app/e2e smoke ;;
  *)
    since="$(node -e 'console.log(new Date(Date.now()-30000).toISOString().slice(0,19)+"Z")')"
    gh workflow run post-deploy-smoke.yml --ref main -f url="$URL" -f expect_commit="$TAG" >/dev/null
    id=""
    for _ in $(seq 1 30); do
      sleep 5
      id="$(gh run list --workflow post-deploy-smoke.yml --event workflow_dispatch --limit 10 --json databaseId,createdAt \
        --jq "[.[] | select(.createdAt >= \"$since\")] | sort_by(.createdAt) | .[0].databaseId // empty")"
      [ -n "$id" ] && break
    done
    [ -n "$id" ] || { echo "staging: smoke run not found"; exit 1; }
    gh run watch "$id" --exit-status --interval 20 >/dev/null ;;
esac
echo "staging: smoke passed"
