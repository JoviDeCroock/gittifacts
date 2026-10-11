/**
 * /forgot-password and /reset-password — a person who forgot their password gets a link by e-mail
 * and chooses a new one. Public (signed out by definition). Only offered where the deployment can
 * send e-mail (api/password.ts); elsewhere /forgot-password says so and names the other ways in.
 */
import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { requestPasswordReset, resetPassword, signInOptions } from "../api/password.js";
import { ConsentFrame, ConsentOutcome } from "../components/ConsentPanel.js";
import "../styles/account.css";
import { Button, LinkButton, Loading } from "../components/ui.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function FormError({ id, message }: { id: string; message: string | null }) {
  return message ? (
    <p class="field__error" id={id} role="alert">
      {message}
    </p>
  ) : null;
}

export function ForgotPassword() {
  const available = useSignal<boolean | null>(null);
  const email = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const sent = useSignal<string | null>(null);

  useEffect(() => {
    document.title = "Reset your password · gittifacts";
    void signInOptions().then((o) => (available.value = o.passwordReset));
  }, []);

  async function submit(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    const value = email.value.trim();
    if (!EMAIL.test(value)) {
      error.value = "Enter the e-mail you sign in with.";
      return;
    }
    busy.value = true;
    error.value = null;
    const r = await requestPasswordReset(value);
    busy.value = false;
    if (r.ok) sent.value = value;
    else error.value = r.message;
  }

  let body: ComponentChildren;
  if (available.value === null)
    body = <Loading label="Checking what this server offers" lines={2} />;
  else if (!available.value) {
    body = (
      <ConsentOutcome
        tone="neutral"
        title="Password reset isn't available here"
        action={
          <LinkButton href="/signin" variant="primary">
            Back to sign in
          </LinkButton>
        }
      >
        <p>This server can't send e-mail, so it can't send you a reset link.</p>
        <p>If you can't sign in, ask whoever runs this server for help.</p>
      </ConsentOutcome>
    );
  } else if (sent.value) {
    body = (
      <ConsentOutcome
        tone="ok"
        title="Check your e-mail"
        action={
          <LinkButton href="/signin" variant="secondary">
            Back to sign in
          </LinkButton>
        }
      >
        <p>
          If an account uses <b>{sent.value}</b>, we sent it a link to choose a new password. The
          link works once, for an hour.
        </p>
      </ConsentOutcome>
    );
  } else {
    body = (
      <form class="reset-form" onSubmit={submit} noValidate aria-labelledby="forgot-title">
        <h1 id="forgot-title" class="reset-form__title">
          Reset your password
        </h1>
        <p class="reset-form__lede">We'll e-mail you a link to choose a new one.</p>
        <label class="field">
          <span class="field__label">Email</span>
          <input
            class="input"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email.value}
            onInput={(e) => (email.value = e.currentTarget.value)}
            aria-invalid={error.value ? "true" : undefined}
            aria-describedby={error.value ? "forgot-error" : undefined}
          />
        </label>
        <FormError id="forgot-error" message={error.value} />
        <Button type="submit" variant="primary" wide busy={busy.value} busyLabel="Sending link…">
          Send the reset link
        </Button>
        <a class="reset-form__back" href="/signin">
          Back to sign in
        </a>
      </form>
    );
  }
  return <ConsentFrame>{body}</ConsentFrame>;
}

export function ResetPassword() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const badLink = params.get("error") !== null || !token;
  const password = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const done = useSignal(false);

  useEffect(() => {
    document.title = "Choose a new password · gittifacts";
  }, []);

  async function submit(e: Event) {
    e.preventDefault();
    if (busy.value || !token) return;
    if (password.value.length < 8) {
      error.value = "Use at least 8 characters.";
      return;
    }
    busy.value = true;
    error.value = null;
    const r = await resetPassword(token, password.value);
    busy.value = false;
    if (r.ok) done.value = true;
    else error.value = r.message;
  }

  let body: ComponentChildren;
  if (badLink) {
    body = (
      <ConsentOutcome
        tone="neutral"
        title="This reset link doesn't work"
        action={
          <LinkButton href="/forgot-password" variant="primary">
            Ask for a new link
          </LinkButton>
        }
      >
        <p>It expired or was already used. Reset links work once, for an hour.</p>
      </ConsentOutcome>
    );
  } else if (done.value) {
    body = (
      <ConsentOutcome
        tone="ok"
        title="Your password is changed"
        action={
          <LinkButton href="/signin" variant="primary">
            Sign in
          </LinkButton>
        }
      >
        <p>Every device that was signed in is signed out. Sign in with the new password.</p>
      </ConsentOutcome>
    );
  } else {
    body = (
      <form class="reset-form" onSubmit={submit} noValidate aria-labelledby="reset-title">
        <h1 id="reset-title" class="reset-form__title">
          Choose a new password
        </h1>
        <label class="field">
          <span class="field__label">New password</span>
          <input
            class="input"
            type="password"
            name="new-password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password.value}
            onInput={(e) => (password.value = e.currentTarget.value)}
            aria-invalid={error.value ? "true" : undefined}
            aria-describedby={error.value ? "reset-error" : "reset-hint"}
          />
        </label>
        <p class="reset-form__hint" id="reset-hint">
          At least 8 characters.
        </p>
        <FormError id="reset-error" message={error.value} />
        <Button type="submit" variant="primary" wide busy={busy.value} busyLabel="Saving…">
          Save the new password
        </Button>
      </form>
    );
  }
  return <ConsentFrame>{body}</ConsentFrame>;
}
