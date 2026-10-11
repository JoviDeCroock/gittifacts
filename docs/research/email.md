# Sending e-mail from the Worker (password reset)

Checked 2026-10-11 against developers.cloudflare.com/email-service (overview and "Send emails"). Used for the
optional password reset (src/auth/email.ts, DECISIONS 2026-10-11).

## What exists

- **Cloudflare Email Service, Email Sending**: outbound transactional e-mail from a Worker through a
  `send_email` binding, or the REST API, or SMTP. Status: **beta**, Workers **Paid** plan.
- **Email Routing** (the older half): inbound routing, free on all plans. Its `send_email` binding can only
  send to **verified destination addresses** in the account. That is fine for alerts to yourself and no use
  for password reset, which mails whoever forgot their password.
- Third-party guides (and the docs' framing) say sending to arbitrary recipients needs the sending domain
  **onboarded** to Email Sending first. Before that, the binding is limited to verified destinations. The
  official pages show arbitrary recipients in their examples but don't state the rule outright, so check
  it on the first live send.

## Setup it needs

1. The sending domain on Cloudflare DNS. Onboard it in the dashboard: Compute → Email Service → Email Sending
   → Onboard Domain. That adds SPF and DKIM TXT records, a DMARC record on `_dmarc.<domain>` and bounce MX
   records on a `cf-bounce` subdomain (propagation "up to 24 hours", usually minutes).
2. The binding in wrangler config: `"send_email": [{ "name": "EMAIL", "remote": true }]`.
3. A sender on that domain (`from`), e.g. `noreply@<domain>`.

## API

```ts
const res = await env.EMAIL.send({ to, from, subject, html, text }); // → { messageId }
```

The send-emails page doesn't document the binding's errors. The REST API answers
`{ success, errors, messages, result: { delivered, permanent_bounces, queued } }`.

## What we did with it

- The binding is **not** declared in `apps/platform/wrangler.jsonc`. Production has no onboarded sending
  domain, and a declared binding nobody can use is a deploy-time risk with no benefit. docs/deploy.md
  ("Outbound e-mail") is the manual step that turns it on.
- The code treats e-mail as configured only when `EMAIL` has a `send` function **and** `EMAIL_FROM` is a
  valid address. Otherwise reset is off: no "Forgot password?" link, and the request endpoint answers 503
  `not-configured` with a fix.
- Tests hand a fake `EMAIL` object through the env (test/password-reset.test.ts). No test reaches the
  account.
- Member invites don't send e-mail at all. The owner copies a single-use link (src/access/invites.ts). If
  e-mail is configured later, the same `Mailer` could send the link too, but the link has to stay the
  bearer secret, bound to the invited e-mail.

Sources: https://developers.cloudflare.com/email-service/ ,
https://developers.cloudflare.com/email-service/get-started/send-emails/ , https://blog.cloudflare.com/email-service/
