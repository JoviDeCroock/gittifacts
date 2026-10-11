/**
 * Linking an installation of our GitHub App to a platform account.
 *
 * GitHub sends the installer to /github/setup?installation_id=…, which anyone could forge. We
 * never trust it: the browser goes through the App's user authorization (client id and secret
 * from Worker config), and the installation is linked only if `GET /user/installations` lists it
 * for that user token (research §7). The OAuth `state` is signed, expires in 10 minutes, names the
 * signed-in human and is bound to a nonce cookie (crypto.ts); the user token is revoked after use.
 */
import type { Caller, Services } from "../app-env.js";
import { GITHUB_WEB } from "./api.js";
import { githubApp } from "./app-config.js";
import { type InstallState, randomNonce, signInstallState, verifyInstallState } from "./crypto.js";
import { getInstallation } from "./store.js";

export const SETTINGS_PATH = "/settings/github";
export const NONCE_COOKIE = "gh_install_nonce";
export const STATE_TTL_MS = 10 * 60_000;

/** A browser flow that ends on the settings page with a reason. */
export class FlowError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FlowError";
  }
}

export function settingsUrl(params: Record<string, string>): string {
  return `${SETTINGS_PATH}?${new URLSearchParams(params).toString()}`;
}

const secretOf = (svc: Services) => (svc.env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET;

/** /github/setup → the App's user authorization; the nonce goes into an HttpOnly cookie. */
export async function beginSetup(
  svc: Services,
  caller: Caller,
  query: { installation_id?: string; setup_action?: string },
): Promise<{ redirect: string; nonce?: string }> {
  if (query.setup_action === "request") return { redirect: settingsUrl({ requested: "1" }) };
  const app = githubApp(svc.env as unknown as Record<string, unknown>);
  if (app === null) throw new FlowError("not-configured");
  const id = query.installation_id ?? "";
  if (!/^\d{1,12}$/.test(id)) throw new FlowError("installation-missing");
  const installationId = Number(id);
  // An installation we know belongs to another App (the Actor App, from M5) isn't linked here.
  const known = await getInstallation(svc.store.db, installationId);
  if (known !== null && known.appId !== app.appId) throw new FlowError("installation-not-yours");
  const nonce = randomNonce();
  const state = await signInstallState(secretOf(svc), {
    principalId: caller.principal.id,
    installationId,
    nonce,
    exp: svc.clock.now().getTime() + STATE_TTL_MS,
  });
  const q = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: `${svc.origin}/github/oauth/callback`,
    state,
  });
  return { redirect: `${GITHUB_WEB}/login/oauth/authorize?${q.toString()}`, nonce };
}

/** Verify the callback's state: ours, unexpired, this human's, this browser's. */
export async function takeState(
  svc: Services,
  caller: Caller,
  state: string | undefined,
  nonce: string | undefined,
): Promise<InstallState> {
  const s = state
    ? await verifyInstallState(secretOf(svc), state, svc.clock.now().getTime())
    : null;
  if (s === null) throw new FlowError("state-expired");
  if (s.principalId !== caller.principal.id) throw new FlowError("state-not-yours");
  if (nonce === undefined || nonce !== s.nonce) throw new FlowError("state-not-this-browser");
  return s;
}
