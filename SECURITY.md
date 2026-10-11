# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security → Advisories) on
this repository rather than in a public issue. Include the affected file or endpoint, what an attacker can do, and
steps to reproduce. This is a personal project: there is no bounty and no SLA, but reports are read and fixed.

## Audit

A full audit was done on 2026-10-11: [docs/security-audit-2026-10-11.md](docs/security-audit-2026-10-11.md). It lists
every finding, what was fixed (and how), and what is still open. Decisions are in `DECISIONS.md` under 2026-10-11.

## If you deploy your own copy

These follow from the platform's design; read them before running it for other people.

- **Lane 0 trusts the author's test environment.** Coverage, mutation, red/green and test-run evidence come from
  running the Change's own tests in the sandbox, as the same user as the evidence tool, so a malicious Change can
  forge them. Leave Lane 0 (auto-merge without a human) off for repositories whose authors you don't trust.
  Paths, policy files, migrations and diff size are always recomputed by the Worker and can't be forged this way.
  See `packages/ci-engine/RUNNER_CONTRACT.md` §3.
- **Give tenant code its own registrable domain.** Project Workers deployed by the platform get a `workers.dev` URL
  under the same account subdomain as the platform, and previews run untrusted code. The platform sends
  `frame-ancestors 'none'`, uses `__Host-` session cookies on https and refuses cross-origin cookie mutations, but the
  strongest setup serves the platform from its own domain and previews from a domain on the Public Suffix List.
- **Set every secret in `apps/platform/.dev.vars.example`.** Missing secrets fail closed (Turnstile refuses claims
  without `TURNSTILE_SECRET_KEY`; `TURNSTILE_TEST_KEYS=1` is for tests and local development only).
- **Set `PLATFORM_ADMINS`** (empty means nobody is an admin) and, in GitHub mode, `GITHUB_REPO_ALLOWLIST` while you
  try it out.
- **Run the admin audit re-verify** (`POST /api/v1/admin/audit/verify`) periodically: normal reads verify the audit
  chain incrementally from a checkpoint.
