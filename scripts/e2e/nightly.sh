#!/usr/bin/env bash
# One tier-3 suite (docs/testing.md) against a deployed platform, reusing the existing live
# scripts (scripts/e2e/*, scripts/journeys/terminal/*). Run by hand; the scheduled e2e-nightly
# workflow is off for now (DECISIONS 2026-10-11):
#
#   GF_HOST=https://gittifacts.decroockjovi.workers.dev E2E_AGENT_TOKEN=… E2E_EMAIL=… E2E_PASSWORD=… \
#     scripts/e2e/nightly.sh m1
#
# Suites: m1 | remote-workspace | merge-queue | m4 | cli-journey | mcp-journey | import-journey
# Credentials come only from the environment (the dedicated E2E account), never argv or logs.
set -euo pipefail

SUITE="${1:?suite}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="${GF_HOST:-https://gittifacts.decroockjovi.workers.dev}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$ROOT"
T="pnpm exec tsx"

need() { for v in "$@"; do [ -n "${!v:-}" ] || { echo "skipped: $v is not set"; exit 78; }; done; }

agent_file() {
  need E2E_AGENT_TOKEN
  umask 077
  node -e 'process.stdout.write(JSON.stringify({ token: process.env.E2E_AGENT_TOKEN }))' > "$WORK/agent.json"
}

# A session for the E2E human (the reviewer), signed in through better-auth like the web app.
cookie_jar() {
  need E2E_EMAIL E2E_PASSWORD
  umask 077
  node -e 'process.stdout.write(JSON.stringify({ email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD }))' |
    curl -sf -c "$WORK/cookies.txt" -o /dev/null -X POST "$HOST/api/auth/sign-in/email" \
      -H "content-type: application/json" -H "origin: $HOST" --data-binary @-
  # On https the session cookie is `__Host-better-auth.session_token` (src/auth/better-auth.ts).
  awk '$6 ~ /^(__Host-|__Secure-)?better-auth\.session_token$/ { print $6 "=" $7 }' "$WORK/cookies.txt"
}

# The terminal journeys record rather than assert: check the metrics that only exist on success.
check_cast() {
  node -e '
    const [file, ...keys] = process.argv.slice(1);
    const m = require(file).metrics ?? {};
    const missing = keys.filter((k) => m[k] === undefined || (k.endsWith("Exit") && m[k] !== 0));
    console.log(JSON.stringify(m));
    if (missing.length) { console.error("journey did not reach: " + missing.join(", ")); process.exit(1); }
  ' "$@"
}

# m1 and remote-workspace work on "the first repo the agent may start changes on": make sure the
# E2E account has one (a workers-api project named e2e-fixture-<random>), without printing the token.
ensure_repo() {
  need E2E_AGENT_TOKEN
  node -e '
    const H = process.argv[1], auth = { authorization: `Bearer ${process.env.E2E_AGENT_TOKEN}` };
    (async () => {
      const repos = (await (await fetch(`${H}/api/v1/repos`, { headers: auth })).json()).repos ?? [];
      if (repos.length > 0) return console.log(`fixture repo: ${repos[0].id}`);
      const name = `e2e-fixture-${Math.random().toString(36).slice(2, 8)}`;
      const r = await fetch(`${H}/api/v1/projects`, { method: "POST",
        headers: { ...auth, "content-type": "application/json", origin: H, "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ template: "workers-api", name }) });
      const b = await r.json();
      if (!r.ok) { console.error(`create fixture repo: HTTP ${r.status} ${b.error?.code ?? ""}`); process.exit(1); }
      console.log(`fixture repo created: ${b.projectId}`);
    })();' "$HOST"
}

case "$SUITE" in
  m1)
    ensure_repo
    GITTIFACTS_URL="$HOST" GITTIFACTS_TOKEN="$E2E_AGENT_TOKEN" $T scripts/e2e/m1.ts --timeout-min 20 ;;
  remote-workspace)
    ensure_repo
    GITTIFACTS_URL="$HOST" GITTIFACTS_TOKEN="$E2E_AGENT_TOKEN" $T scripts/e2e/remote-workspace.ts --timeout-min 20 ;;
  merge-queue)
    need E2E_AGENT_TOKEN E2E_EMAIL E2E_PASSWORD
    GITTIFACTS_REVIEWER_COOKIE="$(cookie_jar)" GITTIFACTS_URL="$HOST" GITTIFACTS_TOKEN="$E2E_AGENT_TOKEN" \
      $T scripts/e2e/merge-queue.ts --timeout-min 40 ;;
  m4)
    need E2E_EMAIL E2E_PASSWORD
    agent_file
    cookie_jar >/dev/null
    $T scripts/e2e/m4.ts --url "$HOST" --agent-file "$WORK/agent.json" --cookie-jar "$WORK/cookies.txt" --timeout-min 50 ;;
  cli-journey)
    GF_HOST="$HOST" $T scripts/journeys/terminal/10-cli-onboarding.ts --out "$WORK"
    check_cast "$WORK/casts/10-cli-onboarding.json" waitExit timeToFirstGreenSec ;;
  mcp-journey)
    agent_file
    GF_HOST="$HOST" $T scripts/journeys/terminal/11-mcp-agent.ts --out "$WORK" --agent-file "$WORK/agent.json"
    check_cast "$WORK/casts/11-mcp-agent.json" timeToFirstGreenSec timeToEvidenceSec timeToTourSec ;;
  import-journey)
    agent_file
    GF_HOST="$HOST" $T scripts/journeys/terminal/12-import-github.ts --out "$WORK" --agent-file "$WORK/agent.json"
    check_cast "$WORK/casts/12-import-github.json" importMs timeToProposalSec timeToLaneSec ;;
  *) echo "unknown suite $SUITE" >&2; exit 2 ;;
esac
