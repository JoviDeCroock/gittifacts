---
title: Connect a deploy platform
description: Let a deploy platform build previews per Change and production from the default branch - install an integration, pick repos, and what it can never do.
order: 49
audience: humans
group: Set up a repo
---

# Connect a deploy platform

Deploy platforms connect to gittifacts the way they connect to GitHub: an OAuth install, webhooks, `git clone`, and deployment statuses reported back. A connected platform builds a preview for each Change and production from the default branch, and its results show up as signed evidence.

**Coming soon.** Cloudflare Workers Builds, Netlify, Vercel, Render and Fly don't ship a gittifacts connector yet. Until they do, use the platform's own [deploy target](/docs/guides/deploy-and-roll-out), or register your own integration as a bridge (step 4).

## 1. Install an integration

You need to be an owner or maintainer of a **claimed** repo.

1. In the deploy platform, choose "Connect to git", then gittifacts. It sends you to the gittifacts install screen.
2. Read what it may do, in plain words, and the list of what it can never do.
3. Pick the repos: all you own or maintain (now and later), or selected ones.
4. Approve. You are sent back to the platform.

Expected: the integration appears under **Settings → Integrations** (`https://<host>/settings/integrations`) with its repos and permissions.

## 2. Know what it can do

| Permission | Lets the platform |
|---|---|
| `repo:read` | See repo names, branches, commits and Changes |
| `contents:read` | Clone and fetch, read-only |
| `webhooks` | Hear about pushes and Changes |
| `deployments:write` | Report deployments; a successful preview becomes signed evidence on its Change |

It can never push, approve, review or merge, change settings, policy or secrets, see your agents' push tokens, or connect to unclaimed projects. A reported preview never lowers a Change's lane.

## 3. Check the results

- **Previews:** the Change's evidence gains a `preview` item with the platform's URL and log link; the tour can cite it.
- **Production:** the deployment shows on the Change's rollout timeline; a failure carries its log link.

## 4. Bridge your own deploy (until connectors ship)

Register an integration for yourself in the developer portal (`https://<host>/settings/integrations/developer`), subscribe to `push` and `change.*` webhooks, and run your platform's CLI when one arrives. For a Workers project:

```sh
git -c http.extraHeader="Authorization: Bearer $INTEGRATION_TOKEN" clone "$CLONE_URL" build && cd build
git checkout "$SHA"
npx wrangler versions upload
```

Report the result with the deployments API so it lands as evidence. The integrator guide walks through every piece: [Integrations](/docs/guides/integrations), with an end-to-end [Cloudflare Workers example](/docs/guides/integrations/cloudflare-workers).

## 5. Uninstall

**Settings → Integrations → Uninstall**. Its tokens stop working on the next request, webhooks stop, and an `installation.deleted` event is the last thing it receives.
