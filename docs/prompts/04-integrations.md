# Build: external integrations (deploy platforms connect to gittifacts)

**Source.** User request (2026-10-02): "We'll also need an OAuth flow for external connections, think letting
Cloudflare/Netlify/... connect to us to deploy applications." The rest of this document is the lead's spec of that
request.

## Why
To supersede GitHub, gittifacts has to be a **git provider other platforms can integrate with**: Cloudflare Workers
Builds, Netlify, Vercel, Render, Fly and others. Their "connect a git provider" flow has to work with gittifacts the way
it works with GitHub or GitLab. The product rule still holds:
- an integration can **read** code and **report** what it deployed;
- an integration can **never** approve, merge or write the default branch;
- deploy results flow back as **evidence**.

## Requirements

1. **Integration (OAuth app) registration.** A developer portal (human, logged in) for registering an integration:
   - name, logo URL, homepage
   - redirect URIs (exact match)
   - webhook URL and webhook secret
   - the permissions it requests

   It gets a `client_id` and a `client_secret` (confidential client; the secret is shown once, stored hashed,
   rotatable). Public PKCE clients are also allowed.

2. **Authorization flow for integrations.** This is OAuth 2.1 authorization code + PKCE, reusing the platform's
   authorization server (built for MCP OAuth in O4) but with a different audience/resource (`<origin>/api`) and
   integration scopes.
   - The consent screen shows the integration, what it may do **in plain words**, and a **repo picker** (all repos,
     or selected ones). The result is an **installation**: integration × human or org × repos.
   - Tokens: short-lived access tokens plus rotating refresh tokens. They are bound to the installation. Revoking
     the installation kills them immediately.
   - Every installation is its own `Principal { kind: "agent" }`-like **integration principal**. It is scoped to the
     installation's repos, with integration-only scopes, and can never hold approval scopes.

3. **Integration scopes** (least privilege; deploy platforms need only the first four):
   - `repo:read`: repo metadata, branches, commits
   - `contents:read`: clone/fetch over git
   - `webhooks`: receive events
   - `deployments:write`: report deployment status and URLs
   - `checks:write`: attach external check results as evidence items. These are always **raise-only** signals,
     like LLM judgments.

4. **Git access for integrations.**
   - Integrations clone from a **gittifacts URL**, `https://<host>/git/<owner>/<repo>.git`, over git smart HTTP, using
     their OAuth access token (Basic `x-access-token:<token>` or Bearer).
   - The Worker proxies **read-only** (`git-upload-pack`) to Artifacts with a freshly minted, short-lived Artifacts
     read token.
   - `git-receive-pack` is refused for integration tokens.

5. **Webhooks.**
   - **Subscribable events:**
     - `push`: default branch and change forks, with ref/before/after
     - `change.created`, `change.updated`, `change.merged`, `change.reverted`
     - `installation.created` and `installation.deleted`
     - `ping`
   - **Payloads:** they carry the clone URL and the commit SHA. A deploy platform can build **previews per Change**
     (from the fork head) and **production from the default branch**.
   - **Signing:** `X-Gittifacts-Signature-256: sha256=<HMAC>` over the raw body with the integration's webhook
     secret; also `X-Gittifacts-Event` and `X-Gittifacts-Delivery`.
   - **Delivery:** at-least-once through Queues, with retries and backoff. A delivery log is visible to the
     integration owner, with a redeliver action.

6. **Deployments API** (so deploy platforms report back):
   - `POST /api/v1/repos/:repoId/deployments { sha, environment: "preview" | "production", changeId? }` and
     `POST /api/v1/deployments/:id/statuses { state: queued | in_progress | success | failure | error, url?, logUrl?, description? }`.
   - A successful preview deployment becomes a `preview` evidence item on the Change, with source = integration,
     signed by the platform, so tours can link it and screenshots can target it.
   - A production deployment is recorded in the rollout timeline. A failed one is shown with its log link.

7. **UI.**
   - **Developer portal:** register and manage integrations, rotate secrets, view the delivery log.
   - **Installed integrations page:** per human or org; what each can do; repos; one-click uninstall.
   - **Consent/installation screen:** follows the existing design system.

8. **Docs for integrators.**
   - A machine- and human-readable `/docs/integrations` page, with the OAuth endpoints, scopes, webhook format and
     verification snippet, the git URL format and the deployments API.
   - OpenAPI coverage.
   - An example: "connect a Cloudflare Workers project to a gittifacts repo".

9. **Security.**
   - An integration never sees agent push tokens, can't push, and can't approve.
   - Unclaimed projects can't be connected to integrations (no production deploys from unclaimed projects).
   - Every install, uninstall, token issue and deployment report is audit-logged.
   - Rate limits per integration.
   - Errors use the standard `{ code, message, fix }`.

## Acceptance
An end-to-end test with a mock deploy platform:
1. Register an integration.
2. Run the OAuth install flow, selecting one repo.
3. Clone over `/git/...` with the access token, and confirm a push is refused.
4. Receive a signed `push` webhook for a new Change and verify the signature.
5. Post a successful preview deployment and see it appear as signed `preview` evidence on the Change.
6. Uninstall, and confirm the token and webhooks stop immediately.
