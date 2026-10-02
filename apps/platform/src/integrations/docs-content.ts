/**
 * The integrator guide served at /docs/integrations (markdown is the source; HTML and JSON are
 * derived). Every URL is absolute for the deployment that serves it.
 */
import { SCOPE_WORDS } from "./scopes.js";

export function integrationsMarkdown(o: string): string {
  const scopes = Object.entries(SCOPE_WORDS)
    .map(([s, w]) => `| \`${s}\` | ${w.title} | ${w.description} |`)
    .join("\n");
  return `# Integrations: connect a deploy platform to gittifacts

gittifacts is a git provider that deploy platforms (Cloudflare Workers Builds, Netlify, Vercel, Render, Fly…) connect to the way they connect to GitHub: OAuth, webhooks, \`git clone\`, and deployment statuses back.

An integration **reads code and reports what it deployed**. It can never push, approve, review or merge, never sees agents' push tokens, and can't be connected to unclaimed projects. Deploy results come back as **evidence** on the Change.

- Developer portal: ${o}/settings/integrations/developer
- Installed integrations: ${o}/settings/integrations
- OpenAPI: ${o}/api/v1/openapi.json (tags \`integrations\`, \`deployments\`, \`git\`)
- Authorization server metadata: ${o}/.well-known/oauth-authorization-server

## 1. Register an integration

In the developer portal (or \`POST ${o}/api/v1/integrations\` with a signed-in session) give a name, homepage, logo URL, **redirect URIs** (matched exactly), the **permissions** you need, and a **webhook URL** + events. You get a \`client_id\` (\`gtic_…\`) and, for a confidential client, a \`client_secret\` (\`gtis_…\`) **shown once** (stored hashed; rotate with up to two active secrets). Without your own webhook secret one is generated (\`whsec_…\`) and shown once. Public clients (no secret, PKCE only) are allowed too.

## 2. Permissions (scopes)

| Scope | In plain words | What it allows |
|---|---|---|
${scopes}

A deploy platform needs \`repo:read contents:read webhooks deployments:write\`. Approval and write scopes (\`plan:approve\`, \`change:review\`, \`repo:admin\`, \`policy:admin\`, \`plan:create\`, \`change:create\`) can never be requested.

## 3. OAuth: install flow

OAuth 2.1 authorization code with **PKCE S256 (required for every integration)**, on the same authorization server agents use, with the HTTP API as the only audience.

1. Send the person to:

\`\`\`
${o}/api/oauth/authorize?response_type=code&client_id=gtic_…&redirect_uri=https%3A%2F%2Fdeploy.example%2Fcallback&scope=repo%3Aread+contents%3Aread+webhooks+deployments%3Awrite&state=…&code_challenge=…&code_challenge_method=S256&resource=${encodeURIComponent(`${o}/api`)}
\`\`\`

2. They sign in, see what you asked for in plain words, pick **all their repositories or selected ones**, and approve. That creates an **installation** (your integration × their account × those repos). They come back to \`redirect_uri?code=…&state=…&iss=${o}&installation_id=ins_…\`.
3. Exchange the code (client_secret_basic shown; client_secret_post works too):

\`\`\`sh
curl -s ${o}/api/oauth/token -u "$CLIENT_ID:$CLIENT_SECRET" \\
  -d grant_type=authorization_code -d code="$CODE" -d code_verifier="$VERIFIER" \\
  -d redirect_uri=https://deploy.example/callback
# → { "access_token": "gti_…", "token_type": "Bearer", "expires_in": 3600,
#     "refresh_token": "gtir_…", "scope": "repo:read contents:read webhooks deployments:write",
#     "installation_id": "ins_…" }
\`\`\`

4. Access tokens last 1 hour. Refresh with \`grant_type=refresh_token\` (same client authentication): you get a new pair and the old refresh token is spent. **Replaying a spent refresh token or code revokes every token of the installation.** Revoke a token with \`POST ${o}/api/oauth/revoke\` (RFC 7009).
5. \`GET ${o}/api/v1/installation\` (Bearer) tells you the account, the granted repositories and their clone URLs.

When the person uninstalls (one click in Settings → Integrations), every token stops working at once and no more events are sent, except a final \`installation.deleted\`.

## 4. Git access

\`\`\`
https://<host>/git/<owner>/<repo>.git                       # the repository (default branch and all refs)
https://<host>/git/<owner>/<repo>/changes/<changeId>.git    # a Change's fork (its head, for previews)
\`\`\`

\`<owner>\` is the owner's handle and \`<repo>\` the repository name; use the \`cloneUrl\` from webhook payloads or \`GET /api/v1/installation\`. Authenticate with the access token as a password (username \`x-access-token\`) or as a Bearer header:

\`\`\`sh
git clone https://x-access-token:$ACCESS_TOKEN@${new URL(o).host}/git/acme/web.git
git -c http.extraHeader="Authorization: Bearer $ACCESS_TOKEN" clone ${o}/git/acme/web.git
\`\`\`

The Worker streams git smart HTTP (\`git-upload-pack\`, protocol v1 and v2) from the storage backend with a fresh 5-minute read credential that never leaves the platform. Needs \`contents:read\`. **\`git push\` (\`git-receive-pack\`) is always refused (403).** Agent tokens (\`gtf_…\`, \`repo:read\`) may clone here too; browser sessions are not git credentials.

## 5. Webhooks

Events: \`push\` (the default branch, and every Change fork push), \`change.created\`, \`change.updated\`, \`change.merged\`, \`change.reverted\`, \`installation.created\`, \`installation.deleted\`, \`ping\`. Only installations that hold \`webhooks\` and cover the repo receive them.

Every delivery is a \`POST\` of JSON with:

| Header | Value |
|---|---|
| \`X-Gittifacts-Event\` | the event name |
| \`X-Gittifacts-Delivery\` | a unique id (the same on redeliveries: dedupe on it) |
| \`X-Gittifacts-Signature-256\` | \`sha256=\` + hex HMAC-SHA-256 of the raw body with your webhook secret |
| \`X-Gittifacts-Installation-Id\` | the installation (absent for \`ping\`) |

Delivery is at least once (a queue), retried after 10 s, 30 s, 2 min, 10 min, 30 min, 1 h and 2 h on anything but a 2xx within 10 s. The delivery log in the developer portal shows every attempt and can redeliver.

A \`push\` to a Change carries what you need for a **preview per Change**; a default-branch push is **production**:

\`\`\`json
{
  "event": "push", "action": null, "deliveryId": "4f1c…", "createdAt": "2026-10-02T09:00:00.000Z",
  "installation": { "id": "ins_…" },
  "repository": { "id": "r_…", "name": "web", "fullName": "acme/web", "owner": "acme", "defaultBranch": "main",
                  "cloneUrl": "${o}/git/acme/web.git", "htmlUrl": "${o}/repos/r_…", "apiUrl": "${o}/api/v1/repos/r_…" },
  "kind": "change", "ref": "refs/heads/main", "before": "…", "after": "<sha>", "sha": "<sha>",
  "cloneUrl": "${o}/git/acme/web/changes/<changeId>.git",
  "change": { "id": "<changeId>", "title": "…", "status": "running", "headSha": "<sha>", "baseSha": "…", "lane": null, "cloneUrl": "…", "htmlUrl": "…" }
}
\`\`\`

Verify the signature over the **raw** body before parsing (Workers / Node 20+):

\`\`\`ts
async function verify(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const hex = header.slice(7);
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const mac = new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  return crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(rawBody)); // constant time
}
\`\`\`

## 6. Deployments API

\`\`\`sh
# 1. a deployment of a commit (changeId ties a preview to its Change)
curl -s ${o}/api/v1/repos/$REPO_ID/deployments -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" -d '{"sha":"<sha>","environment":"preview","changeId":"<changeId>"}'
# 2. its status as it goes (queued | in_progress | success | failure | error)
curl -s ${o}/api/v1/deployments/$DEPLOYMENT_ID/statuses -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" -d '{"state":"success","url":"https://<preview>.example.dev","logUrl":"https://…/logs"}'
\`\`\`

- A **successful preview** becomes a signed \`preview\` evidence item on the Change (\`source.kind: "integration"\`), so tours link it and screenshots can target it. It is informational: it never lowers a Change's lane.
- A **production** deployment (from the default branch) is recorded in the merged Change's rollout timeline; a failed one shows with its log link.
- Every report is audit-logged. Needs \`deployments:write\`; the repo must be in the installation.

## 7. Example: connect a Cloudflare Workers project

1. Register "Cloudflare Workers Builds" in the developer portal: homepage \`https://dash.cloudflare.com\`, redirect URI \`https://dash.cloudflare.com/oauth/gittifacts/callback\`, permissions \`repo:read contents:read webhooks deployments:write\`, webhook URL \`https://builds.example/webhooks/gittifacts\`, events \`push\`, \`change.created\`, \`change.merged\`, \`installation.*\`.
2. In the Workers project's settings, "Connect to git" → gittifacts runs §3: the person installs it on \`acme/web\` only.
3. On \`push\` with \`kind: "change"\`: clone \`cloneUrl\` at \`sha\`, run \`wrangler versions upload\` (a preview URL per version), then report \`environment: "preview"\` with \`changeId\` and the preview URL → it appears as evidence on the Change.
4. On \`push\` with \`kind: "default-branch"\` (only the merge queue moves it): build \`sha\`, \`wrangler deploy\`, report \`environment: "production"\` → it shows in the rollout timeline.
5. Keep tokens fresh with the refresh token; on \`installation.deleted\` drop the connection.

## Errors and limits

Platform JSON errors are \`{ "error": { "code", "message", "fix": { "explanation", … } } }\`; the token and revocation endpoints answer RFC 6749 \`{ "error", "error_description", "fix" }\`. Each integration has one request budget across its installations (HTTP 429 \`rate-limited\` with \`Retry-After\`).
`;
}
