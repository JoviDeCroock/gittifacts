---
title: "Example: connect a Cloudflare Workers project"
description: End to end — register a Workers Builds integration, install it on one repo, build previews per Change and production from the default branch, report back.
order: 6
---

# Example: connect a Cloudflare Workers project

1. **Register** "Cloudflare Workers Builds" in the developer portal:
   - homepage `https://dash.cloudflare.com`;
   - redirect URI `https://dash.cloudflare.com/oauth/gittifacts/callback`;
   - permissions `repo:read contents:read webhooks deployments:write`;
   - webhook URL `https://builds.example/webhooks/gittifacts`, with events `push`, `change.created`, `change.merged`, `installation.created` and `installation.deleted`.

   Store the client secret and webhook secret it shows once.
2. **Connect**: in the Workers project's settings, choose "Connect to git", then gittifacts. That runs the [install flow](./oauth.md), and the person installs it on `acme/web` only. Keep the refresh token and `installation_id`.
3. **Preview per Change**: on `push` with `kind: "change"`:
   1. clone `cloneUrl` at `sha` (Basic `x-access-token:<token>`);
   2. run `wrangler versions upload`, which gives a preview URL per version;
   3. report `environment: "preview"` with `changeId` and that URL.

   It appears as signed evidence on the Change.
4. **Production**: on `push` with `kind: "default-branch"`:
   1. build `sha` (only gittifacts' merge queue ever moves the default branch);
   2. run `wrangler deploy`;
   3. report `environment: "production"`.

   It shows in the Change's rollout timeline.
5. **Housekeeping**: refresh the access token before it expires (1 h). On `installation.deleted`, drop the connection. Use the delivery log to debug a missed event, and redeliver from there.
