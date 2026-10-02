#!/usr/bin/env bash
# Wire Workers Issues of every project Worker to the platform (idempotent; account-level, once).
#
#   scripts/setup-workers-issues.sh --url https://<host> --secret-file <0600 file> [--rotate]
#
# Creates, unless they exist (looked up by name):
#   1. a Notifications generic-webhook destination  gittifacts-workers-issues → <url>/webhooks/workers-issues,
#      with the shared secret Cloudflare echoes in `cf-webhook-auth` (the platform's ISSUES_WEBHOOK_SECRET);
#   2. a Notifications policy  gittifacts-workers-issues  (alert_type workers_observability_real_time_issue);
#   3. an account-wide Issues automation  gittifacts-project-workers  (fires on an issue's first occurrence).
#
# Account-wide, not one per project: an account has at most 50 automations, and the webhook keeps
# only project Workers (`gf-…`). Project Workers get Issues from the deployer (observability.issues).
# `--rotate` sets the secret on an existing destination (set the same value on the Worker first:
# `wrangler secret put ISSUES_WEBHOOK_SECRET < <file>`). Needs the `cf` CLI logged in with
# Notifications and Workers Observability write access. Never prints the secret.
set -euo pipefail

URL=""
SECRET_FILE=""
ROTATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift 2 ;;
    --secret-file) SECRET_FILE="$2"; shift 2 ;;
    --rotate) ROTATE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$URL" ] || { echo "--url is required" >&2; exit 2; }
NAME="gittifacts-workers-issues"
AUTOMATION="gittifacts-project-workers"
HOOK="$URL/webhooks/workers-issues"

secret() {
  [ -n "$SECRET_FILE" ] && [ -r "$SECRET_FILE" ] || { echo "--secret-file is required" >&2; exit 2; }
  tr -d '\n' < "$SECRET_FILE"
}

dest=$(cf alerting destinations webhooks list 2>/dev/null | jq -r --arg n "$NAME" '[.[] | select(.name == $n)][0].id // empty')
if [ -z "$dest" ]; then
  dest=$(jq -n --arg n "$NAME" --arg u "$HOOK" --arg s "$(secret)" '{name: $n, url: $u, secret: $s}' |
    cf alerting destinations webhooks create --body "$(cat)" 2>/dev/null | jq -r '.id')
  echo "created destination $dest → $HOOK"
elif [ "$ROTATE" -eq 1 ]; then
  jq -n --arg n "$NAME" --arg u "$HOOK" --arg s "$(secret)" '{name: $n, url: $u, secret: $s}' |
    cf alerting destinations webhooks update "$dest" --body "$(cat)" >/dev/null 2>&1
  echo "rotated the secret of destination $dest"
else
  echo "destination $dest exists"
fi

policy=$(cf alerting policies list 2>/dev/null | jq -r --arg n "$NAME" '[.[] | select(.name == $n)][0].id // empty')
if [ -z "$policy" ]; then
  body=$(jq -n --arg n "$NAME" --arg d "$dest" '{name: $n, enabled: true,
    description: "Workers Issues of project Workers (gf-*) → gittifacts rollout detection",
    alert_type: "workers_observability_real_time_issue", mechanisms: {webhooks: [{id: $d}]}}')
  policy=$(cf alerting policies create --body "$body" 2>/dev/null | jq -r '.id')
  echo "created policy $policy"
else
  echo "policy $policy exists"
fi

auto=$(cf observability issues automations list 2>/dev/null |
  jq -r --arg n "$AUTOMATION" '[.automations[] | select(.name == $n)][0].id // empty')
if [ -z "$auto" ]; then
  body=$(jq -n --arg n "$AUTOMATION" --arg p "$policy" '{policyId: $p, name: $n, enabled: true, afterOccurrences: 1}')
  auto=$(cf observability issues automations create --body "$body" 2>/dev/null | jq -r '.automation.id')
  echo "created account-wide automation $auto"
else
  echo "automation $auto exists"
fi
