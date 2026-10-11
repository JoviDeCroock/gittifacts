/**
 * Outbound e-mail, optional (docs/research/email.md). Today it carries one message: the password
 * reset link. Configured only when BOTH are set:
 *
 *   - `EMAIL`: a Cloudflare Email Service `send_email` binding (declared by hand in
 *     wrangler.jsonc once a sending domain is onboarded; docs/deploy.md), and
 *   - `EMAIL_FROM`: the sender address on that onboarded domain.
 *
 * Without them the platform still deploys and runs; password reset answers 503 with a fix and the
 * sign-in page hides "Forgot password?". Tests hand a fake `EMAIL` through the env.
 */
import { z } from "zod";

export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

/** The structural part of the Email Service binding we use (`env.EMAIL.send({...})`). */
export interface SendEmailBinding {
  send(message: OutboundEmail): Promise<unknown>;
}

/** The optional bindings, read from any env (wrangler's generated `Env` doesn't declare them). */
export interface EmailBindings {
  EMAIL?: unknown;
  EMAIL_FROM?: unknown;
}

export interface Mailer {
  from: string;
  send(message: Omit<OutboundEmail, "from">): Promise<void>;
}

const From = z.string().trim().email().max(320);

function isSendBinding(x: unknown): x is SendEmailBinding {
  return (
    typeof x === "object" && x !== null && typeof (x as { send?: unknown }).send === "function"
  );
}

/** The mailer, or null when e-mail is not configured on this deployment. */
export function mailerFor(env: object): Mailer | null {
  const { EMAIL: binding, EMAIL_FROM } = env as EmailBindings;
  const from = From.safeParse(EMAIL_FROM ?? "");
  if (!isSendBinding(binding) || !from.success) return null;
  return {
    from: from.data,
    async send(message) {
      await binding.send({ ...message, from: from.data });
    },
  };
}

export function emailConfigured(env: object): boolean {
  return mailerFor(env) !== null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** The reset message: the link, how long it works, and what to do if you didn't ask. */
export function resetPasswordEmail(to: string, url: string): Omit<OutboundEmail, "from"> {
  const text = [
    "Someone asked to reset the password of your gittifacts account.",
    "",
    `Choose a new password: ${url}`,
    "",
    "The link works once, for an hour. If you didn't ask, ignore this e-mail: your password stays as it is.",
  ].join("\n");
  const safe = escapeHtml(url);
  const html = `<p>Someone asked to reset the password of your gittifacts account.</p><p><a href="${safe}">Choose a new password</a></p><p>The link works once, for an hour. If you didn't ask, ignore this e-mail: your password stays as it is.</p>`;
  return { to, subject: "Reset your gittifacts password", text, html };
}
