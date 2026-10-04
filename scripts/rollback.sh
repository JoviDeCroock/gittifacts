#!/usr/bin/env bash
# Roll the platform Worker back to the version that was live before a deploy, but only if the
# deploy is still what is live (never undo someone else's newer deploy). Used by the post-deploy
# smoke (.github/workflows/post-deploy-smoke.yml) and scripts/deploy-clean.sh; docs/testing.md.
#
#   scripts/rollback.sh --url <origin> --deployed <version-id> --to <previous-version-id> \
#     [--worker gittifacts] [--reason "post-deploy smoke failed for <sha>"] [--dry-run]
#
# Needs wrangler credentials (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in CI, or a local
# `wrangler login`) unless --dry-run. Exits 0 after a verified rollback or when nothing needed
# rolling back, 1 when the rollback failed or could not be verified.
# D1 migrations are NOT rolled back: they must stay backwards compatible (docs/deploy.md).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="" DEPLOYED="" TO="" REASON="post-deploy smoke failed" DRY=0 WORKER=gittifacts
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift 2 ;;
    --deployed) DEPLOYED="$2"; shift 2 ;;
    --to) TO="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --worker) WORKER="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "rollback: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$URL" ] && [ -n "$DEPLOYED" ] && [ -n "$TO" ] || { echo "rollback: need --url, --deployed and --to" >&2; exit 2; }

live_version() {
  # The x-gittifacts-version header is on every response, including /start (health may be new).
  curl -s -o /dev/null -D - -m 20 "$URL/start" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-gittifacts-version"{print $2}'
}

LIVE="$(live_version || true)"
echo "rollback: live=$LIVE deployed=$DEPLOYED previous=$TO"
if [ "$LIVE" = "$TO" ]; then echo "rollback: the previous version is already live"; exit 0; fi
if [ -n "$LIVE" ] && [ "$LIVE" != "$DEPLOYED" ]; then
  echo "rollback: live is neither the deployed nor the previous version (a newer deploy?): not touching it"
  exit 1
fi

# WRANGLER: how to run wrangler (CI without a full install: "npx --yes wrangler@<version>").
read -r -a WR <<< "${WRANGLER:-pnpm exec wrangler}"
CMD=("${WR[@]}" rollback "$TO" --name "$WORKER" --yes --message "$REASON")
if [ "$DRY" -eq 1 ]; then
  echo "rollback: DRY RUN, would run in apps/platform: ${CMD[*]}"
  exit 0
fi
(cd "$ROOT/apps/platform" && CI=1 "${CMD[@]}")

# Verify: the previous version answers within two minutes (deadline, not a fixed sleep).
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$(live_version || true)" = "$TO" ]; then echo "rollback: verified, $TO is live"; exit 0; fi
  sleep 5
done
echo "rollback: wrangler rollback ran but $URL does not report $TO yet" >&2
exit 1
