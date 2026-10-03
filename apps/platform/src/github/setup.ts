/**
 * Creating our GitHub Apps (manifest flow) and linking installations to platform accounts.
 *
 * Manifest flow (docs/research/github-app.md §7): a platform admin asks for a manifest → the
 * browser form-POSTs it to GitHub with a signed, single-use, one-hour `state` → GitHub redirects
 * to /github/manifest/callback → we exchange the code and seal the App's credentials.
 *
 * Install verification: GitHub sends the installer to /github/setup?installation_id=…, which
 * anyone could forge. We never trust it: the browser goes through the App's user authorization,
 * and the installation is linked only if `GET /user/installations` (with that user token) lists
 * it. The user token is revoked right after.
 */
import type { Caller, Services } from "../app-env.js";
import { assertPlatformAdmin } from "../limits/routes.js";
import { GITHUB_WEB } from "./api.js";
import { githubKeys, randomNonce, signState, verifiedStateNonce } from "./crypto.js";
import {
  type AppKind,
  buildManifest,
  defaultAppName,
  type ManifestRequest,
  manifestAction,
} from "./manifest.js";
import {
  consumeState,
  createState,
  type GithubStateRow,
  getInstallation,
  listApps,
  STATE_TTL_MS,
} from "./store.js";

export const SETTINGS_PATH = "/settings/github";

/** A browser flow that ends on the settings page with a reason. */
export class FlowError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FlowError";
  }
}

export interface GithubFlowEnv {
  GITHUB_APP_KEK?: string;
  PLATFORM_ADMINS?: string;
  /** "on" enables per-customer Actor Apps (M5). */
  GITHUB_ACTOR_APPS?: string;
}

export function settingsUrl(params: Record<string, string>): string {
  return `${SETTINGS_PATH}?${new URLSearchParams(params).toString()}`;
}

export async function issueState(
  svc: Services,
  purpose: GithubStateRow["purpose"],
  principalId: string,
  data: Record<string, unknown>,
): Promise<{ state: string; expiresAt: string }> {
  const keys = await githubKeys((svc.env as GithubFlowEnv).GITHUB_APP_KEK);
  const nonce = randomNonce();
  const now = svc.clock.now();
  const expiresAt = new Date(now.getTime() + STATE_TTL_MS).toISOString();
  await createState(svc.store.db, {
    id: nonce,
    purpose,
    principalId,
    data,
    createdAt: now.toISOString(),
    expiresAt,
  });
  return { state: await signState(keys, nonce), expiresAt };
}

/** Verify the MAC, consume once, and check it was issued to this caller. */
export async function takeState(
  svc: Services,
  caller: Caller,
  purpose: GithubStateRow["purpose"],
  state: string | undefined,
): Promise<GithubStateRow> {
  const keys = await githubKeys((svc.env as GithubFlowEnv).GITHUB_APP_KEK);
  const nonce = state ? await verifiedStateNonce(keys, state) : null;
  if (!nonce) throw new FlowError("state-invalid");
  const row = await consumeState(svc.store.db, nonce, purpose, svc.clock.now());
  if (!row) throw new FlowError("state-expired");
  if (row.principalId !== caller.principal.id) throw new FlowError("state-not-yours");
  return row;
}

export interface ManifestStart {
  kind: AppKind;
  name: string;
  org: string | null;
  /** Form action (GitHub), already carrying `?state=`. */
  action: string;
  /** The `manifest` form field (JSON). */
  manifest: string;
  state: string;
  expiresAt: string;
}

export async function startManifest(
  svc: Services,
  caller: Caller,
  req: ManifestRequest,
): Promise<ManifestStart> {
  const env = svc.env as GithubFlowEnv;
  assertPlatformAdmin(caller, env);
  if (req.kind === "actor") {
    if (env.GITHUB_ACTOR_APPS !== "on") throw new FlowError("actor-apps-disabled");
    if (!req.org) throw new FlowError("actor-needs-org");
  }
  const name = req.name ?? defaultAppName(req.kind, req.org);
  const { state, expiresAt } = await issueState(svc, "manifest", caller.principal.id, {
    kind: req.kind,
    org: req.org ?? null,
    name,
  });
  return {
    kind: req.kind,
    name,
    org: req.org ?? null,
    action: manifestAction(req.org, state),
    manifest: JSON.stringify(buildManifest(req.kind, svc.origin, name)),
    state,
    expiresAt,
  };
}

/** /github/setup → the App's user authorization (never trusting `installation_id` alone). */
export async function beginSetup(
  svc: Services,
  caller: Caller,
  query: { installation_id?: string; setup_action?: string },
): Promise<string> {
  if (query.setup_action === "request") return settingsUrl({ requested: "1" });
  const id = query.installation_id ?? "";
  if (!/^\d{1,12}$/.test(id)) throw new FlowError("installation-missing");
  const installationId = Number(id);
  const apps = await listApps(svc.store.db);
  const known = await getInstallation(svc.store.db, installationId);
  // The installation webhook usually lands first and names the App; otherwise the Reader App.
  const app =
    apps.find((a) => a.id === known?.appId) ?? apps.find((a) => a.kind === "reader") ?? apps[0];
  if (!app) throw new FlowError("no-app");
  const { state } = await issueState(svc, "install", caller.principal.id, {
    installationId,
    appId: app.id,
  });
  const q = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: `${svc.origin}/github/oauth/callback`,
    state,
  });
  return `${GITHUB_WEB}/login/oauth/authorize?${q.toString()}`;
}
