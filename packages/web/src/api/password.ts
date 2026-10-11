/**
 * Sign-in options and password reset (apps/platform/src/auth/password-reset.ts). Reset exists only
 * where the deployment can send e-mail; `signInOptions()` says so, and the sign-in page shows
 * "Forgot password?" only then. Reset calls go to better-auth's endpoints, whose errors are
 * `{ code, message }` rather than the platform envelope, so this module reads both.
 */
import { isMockMode } from "./mode.js";

export interface SignInOptions {
  passwordReset: boolean;
}

export type ResetResult = { ok: true } | { ok: false; message: string };

const OFF: SignInOptions = { passwordReset: false };

let cached: Promise<SignInOptions> | null = null;

/** Fetched once per page load; any failure reads as "nothing extra" (never shows a dead link). */
export function signInOptions(): Promise<SignInOptions> {
  if (isMockMode()) return Promise.resolve(OFF);
  cached ??= fetch("/api/v1/sign-in-options", { credentials: "same-origin" })
    .then(async (r) => (r.ok ? ((await r.json()) as SignInOptions) : OFF))
    .catch(() => OFF);
  return cached;
}

async function post(path: string, body: unknown): Promise<ResetResult> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      message: "The server could not be reached. Check your connection and try again.",
    };
  }
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => null)) as {
    code?: string;
    message?: string;
    error?: { message?: string; fix?: { explanation?: string } };
  } | null;
  if (data?.error?.fix?.explanation) return { ok: false, message: data.error.fix.explanation };
  if (data?.code === "INVALID_TOKEN") {
    return {
      ok: false,
      message: "This reset link has expired or was already used. Ask for a new one.",
    };
  }
  if (data?.code === "PASSWORD_TOO_SHORT")
    return { ok: false, message: "Use at least 8 characters." };
  return {
    ok: false,
    message: data?.message ?? data?.error?.message ?? `The server answered ${res.status}.`,
  };
}

/** E-mail a reset link (the answer is the same whether or not the account exists). */
export function requestPasswordReset(email: string): Promise<ResetResult> {
  return post("/api/auth/request-password-reset", {
    email,
    redirectTo: `${window.location.origin}/reset-password`,
  });
}

/** Set a new password with the token from the e-mailed link. Signs the account out everywhere. */
export function resetPassword(token: string, newPassword: string): Promise<ResetResult> {
  return post("/api/auth/reset-password", { token, newPassword });
}
