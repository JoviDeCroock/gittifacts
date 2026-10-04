#!/usr/bin/env bash
# Generated artifacts must match the code they are generated from (docs/testing.md, tier 1).
# Stale generated docs once reached production because nothing compared them before a deploy.
#
#   scripts/check-generated.sh        # exits 1 and names what to regenerate
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0

step() { echo "== $1"; }

step "docs reference pages (packages/docs/content/reference) match the code"
if ! pnpm --filter @app/docs exec tsx generate/index.ts --check; then
  echo "   stale: run \`pnpm --filter @app/docs generate\` and commit the result"; fail=1
fi

step "MCP contract snapshot (packages/mcp/tools.introspection.d.ts) matches tools/list"
if ! pnpm --filter @app/mcp exec vitest run test/snapshot.test.ts --reporter=dot; then
  echo "   stale: run \`pnpm --filter @app/mcp snapshot\` and commit the result"; fail=1
fi

step "bundled templates (apps/platform/src/generated/templates.ts) match templates/"
pnpm --filter @app/platform run bundle-templates >/dev/null
if ! git diff --exit-code --stat -- apps/platform/src/generated; then
  echo "   stale: run \`pnpm --filter @app/platform bundle-templates\` and commit the result"; fail=1
fi

step "docs check (links, samples, page rules)"
if ! pnpm --filter @app/docs check; then fail=1; fi

[ "$fail" -eq 0 ] && echo "generated artifacts: fresh" || echo "generated artifacts: STALE (see above)"
exit "$fail"
