/**
 * Session state for the signed-in human, in signals. better-auth handles the cookie session;
 * `/api/v1/me` resolves it to a platform Principal.
 */
import { computed, signal } from "@preact/signals";
import { ApiError, api } from "../api/client.js";
import { isMockMode } from "../api/mode.js";
import type { MeResponse } from "../api/types.js";

export type SessionState =
  | { status: "loading" }
  | { status: "anon"; reason?: "signed-out" | "expired" }
  | { status: "error"; message: string }
  | { status: "authed"; me: MeResponse };

export const session = signal<SessionState>({ status: "loading" });

export const principal = computed(() => (session.value.status === "authed" ? session.value.me.principal : null));
export const userName = computed(() => {
  const s = session.value;
  if (s.status !== "authed") return "";
  return s.me.user?.name ?? s.me.principal.name;
});

export async function loadSession(): Promise<void> {
  try {
    const me = await api.me();
    session.value = { status: "authed", me };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) session.value = { status: "anon" };
    else session.value = { status: "error", message: err instanceof Error ? err.message : "Unknown error" };
  }
}

/** Called by data loaders when the API answers 401 mid-session. */
export function sessionExpired(): void {
  session.value = { status: "anon", reason: "expired" };
}

export interface AuthResult {
  ok: boolean;
  message?: string;
}

async function authClient() {
  const { createAuthClient } = await import("better-auth/client");
  return createAuthClient({ baseURL: window.location.origin });
}

export async function signInWithEmail(email: string, password: string): Promise<AuthResult> {
  if (isMockMode()) {
    const { mockSignIn } = await import("../api/mock.js");
    mockSignIn();
    await loadSession();
    return { ok: true };
  }
  const client = await authClient();
  const { error } = await client.signIn.email({ email, password });
  if (error) return { ok: false, message: error.message ?? "Email or password is incorrect." };
  await loadSession();
  return { ok: true };
}

export async function signUpWithEmail(name: string, email: string, password: string): Promise<AuthResult> {
  if (isMockMode()) return signInWithEmail(email, password);
  const client = await authClient();
  const { error } = await client.signUp.email({ name, email, password });
  if (error) return { ok: false, message: error.message ?? "Could not create the account." };
  await loadSession();
  return { ok: true };
}

export async function signInWithGitHub(): Promise<AuthResult> {
  if (isMockMode()) return signInWithEmail("maya@acme.dev", "demo");
  const client = await authClient();
  const { error } = await client.signIn.social({ provider: "github", callbackURL: window.location.pathname || "/" });
  if (error) return { ok: false, message: error.message ?? "GitHub sign-in did not start." };
  return { ok: true };
}

export async function signOut(): Promise<void> {
  if (isMockMode()) {
    const { mockSignOut } = await import("../api/mock.js");
    mockSignOut();
  } else {
    const client = await authClient();
    await client.signOut();
  }
  session.value = { status: "anon", reason: "signed-out" };
}
