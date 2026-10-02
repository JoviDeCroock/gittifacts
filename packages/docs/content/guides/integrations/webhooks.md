---
title: Webhooks
description: Events, signed deliveries (X-Gittifacts-Signature-256), retries, redelivery, payload format and a verification snippet.
order: 4
---

# Webhooks

## Events

| Event | When |
|---|---|
| `push` | The default branch moved (`kind: "default-branch"`, which is production), or a Change's fork was pushed (`kind: "change"`, a preview per Change) |
| `change.created`, `change.updated`, `change.merged`, `change.reverted` | A Change's lifecycle |
| `installation.created`, `installation.deleted` | Someone installed or uninstalled your integration |
| `ping` | You pressed "Send ping" in the developer portal |

Only installations that hold `webhooks` and cover the repo receive repo events.

## Delivery

Every delivery is a `POST` of JSON with these headers:

| Header | Value |
|---|---|
| `X-Gittifacts-Event` | the event name |
| `X-Gittifacts-Delivery` | a unique id, the same on redeliveries (dedupe on it) |
| `X-Gittifacts-Signature-256` | `sha256=` + hex HMAC-SHA-256 of the raw body with your webhook secret |
| `X-Gittifacts-Installation-Id` | the installation (absent for `ping`) |

Delivery is **at least once**, through a queue. Anything but a 2xx within 10 s is retried after 10 s, 30 s, 2 min, 10 min, 30 min, 1 h and 2 h. After that the delivery is marked failed. The developer portal's delivery log shows every attempt (request headers, payload, response) and can redeliver.

## Payload

A `push` carries the clone URL and the commit to build:

```json
{
  "event": "push", "action": null, "deliveryId": "4f1c…", "createdAt": "2026-10-02T09:00:00.000Z",
  "installation": { "id": "ins_…" },
  "repository": { "id": "r_…", "name": "web", "fullName": "acme/web", "owner": "acme",
                  "defaultBranch": "main", "cloneUrl": "https://<host>/git/acme/web.git",
                  "htmlUrl": "https://<host>/repos/r_…", "apiUrl": "https://<host>/api/v1/repos/r_…" },
  "kind": "change", "ref": "refs/heads/main", "before": "…", "after": "<sha>", "sha": "<sha>",
  "cloneUrl": "https://<host>/git/acme/web/changes/<changeId>.git",
  "change": { "id": "<changeId>", "title": "…", "status": "running", "headSha": "<sha>",
              "baseSha": "…", "lane": null, "cloneUrl": "…", "htmlUrl": "…", "apiUrl": "…" }
}
```

The `change.*` events carry `repository`, `change`, `cloneUrl` and `sha`. For `change.merged`, `cloneUrl` is the repository's and `sha` is the merged commit.

## Verify the signature

Verify over the **raw** body, before parsing. This works on Workers and Node 20+:

```ts
async function verify(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const hex = header.slice(7);
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const mac = new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(rawBody));
}
```
