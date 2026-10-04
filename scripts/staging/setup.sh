#!/usr/bin/env bash
# ONE-TIME creation of the staging resources (docs/testing.md, "Staging"). Creates resources in
# the Cloudflare account, so it runs only after the owner approved this exact list:
#
#   D1 gittifacts-staging · R2 gittifacts-staging-blobs (EU) · queues gittifacts-staging-webhooks,
#   gittifacts-staging-webhooks-dlq, gittifacts-staging-github-events,
#   gittifacts-staging-github-events-dlq · Worker gittifacts-staging (first deploy) with three
#   generated secrets (PLATFORM_SIGNING_KEY, BETTER_AUTH_SECRET, ISSUES_WEBHOOK_SECRET).
#
#   scripts/staging/setup.sh --yes-i-have-approval
# Idempotent: existing resources are kept. Prints the D1 id to store as STAGING_D1_ID.
set -euo pipefail
[ "${1:-}" = "--yes-i-have-approval" ] || { sed -n '2,12p' "$0"; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/apps/platform"
W="pnpm exec wrangler"

$W d1 create gittifacts-staging --location weur 2>/dev/null || echo "d1: exists"
D1_ID="$($W d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).find(x=>x.name==="gittifacts-staging");console.log(d?d.uuid:"")})')"
[ -n "$D1_ID" ] || { echo "no D1 id"; exit 1; }
$W r2 bucket create gittifacts-staging-blobs --jurisdiction eu 2>/dev/null || echo "r2: exists"
for q in gittifacts-staging-webhooks gittifacts-staging-webhooks-dlq gittifacts-staging-github-events gittifacts-staging-github-events-dlq; do
  $W queues create "$q" 2>/dev/null || echo "queue $q: exists"
done
CONFIG="$(cd "$ROOT" && pnpm exec tsx scripts/staging/config.ts --d1-id "$D1_ID")"
$W d1 migrations apply DB --remote --config "$CONFIG"
# Secrets: fresh values, never printed, never the production ones.
KEY="$(cd "$ROOT" && node -e '
  const { webcrypto: c } = require("node:crypto");
  (async () => { const p = await c.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const b = (x) => Buffer.from(x).toString("base64url");
    console.log(JSON.stringify({ privateKey: b(await c.subtle.exportKey("pkcs8", p.privateKey)),
      publicKey: b(await c.subtle.exportKey("raw", p.publicKey)), name: "staging" })); })();')"
printf '%s' "$KEY" | $W secret put PLATFORM_SIGNING_KEY --config "$CONFIG"
openssl rand -hex 32 | tr -d '\n' | $W secret put BETTER_AUTH_SECRET --config "$CONFIG"
openssl rand -hex 16 | tr -d '\n' | $W secret put ISSUES_WEBHOOK_SECRET --config "$CONFIG"
echo "staging ready. STAGING_D1_ID=$D1_ID (deploy with scripts/staging/deploy.sh)"
