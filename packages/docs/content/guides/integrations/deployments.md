---
title: Deployments API
description: Report preview and production deployments back to gittifacts; successful previews become signed evidence on the Change.
order: 5
---

# Deployments API

Deploy platforms report what they deployed. Each report needs `deployments:write`, and the repo must be in the installation.

```sh
# 1. a deployment of a commit (changeId ties a preview to its Change)
curl -s https://<host>/api/v1/repos/$REPO_ID/deployments \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"sha":"<sha>","environment":"preview","changeId":"<changeId>"}'

# 2. its status as it goes: queued | in_progress | success | failure | error
curl -s https://<host>/api/v1/deployments/$DEPLOYMENT_ID/statuses \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"state":"success","url":"https://<preview>.example.dev","logUrl":"https://…/logs"}'
```

- **A successful preview becomes a signed `preview` evidence item on the Change.** Its id is `preview:<integrationId>`, and it carries `source: { kind: "integration", name, deploymentId, logUrl }`. Tours link it and screenshots can target it.
- The preview is informational: it never lowers (or raises) a Change's lane.
- If the Change's evidence isn't sealed yet, the preview is attached when it is.
- **Production** deployments (from the default branch) are recorded in the merged Change's rollout timeline. A failed one shows with its log link. Without `changeId`, the Change is found by its merged commit.
- `GET /api/v1/deployments/{id}` and `GET /api/v1/repos/{repoId}/deployments` list reports with their status history.
- Every report is audit-logged. Unclaimed projects take no reports.
