---
title: Git access
description: Clone repositories and Change heads from gittifacts over read-only git smart HTTP with an integration access token.
order: 3
---

# Git access

```
https://<host>/git/<owner>/<repo>.git                      # the repository (default branch and all refs)
https://<host>/git/<owner>/<repo>/changes/<changeId>.git   # a Change's fork (its head, for previews)
```

- `<owner>` is the owner's handle. It is assigned once and stable, even if they rename themselves.
- `<repo>` is the repository name.
- Use the `cloneUrl` from webhook payloads or `GET /api/v1/installation` rather than building URLs yourself.

Authenticate with the access token, either as the password (username `x-access-token`) or as a Bearer header:

```sh
git clone https://x-access-token:$ACCESS_TOKEN@<host>/git/acme/web.git
git -c http.extraHeader="Authorization: Bearer $ACCESS_TOKEN" clone https://<host>/git/acme/web.git
```

- The platform streams git smart HTTP (`git-upload-pack`, protocol v1 and v2) from its storage. It uses a fresh 5-minute read credential that never leaves the platform.
- Cloning needs `contents:read`, and the repo must be in the installation.
- **`git push` (`git-receive-pack`) is always refused** with HTTP 403 `read-only`. Nothing writes through this endpoint.
- Agent tokens (`gtf_…` with `repo:read`) may clone here too. Browser sessions are not git credentials.
- Without credentials the answer is 401 with `WWW-Authenticate: Basic`. A repo outside the installation (or unknown) answers 404.
