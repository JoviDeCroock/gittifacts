/** The two GitHub redirects back to us: manifest conversion and user authorization. */
import type { Caller, Services } from "../app-env.js";
import { assertPlatformAdmin } from "../limits/routes.js";
import {
  convertManifest,
  exchangeUserCode,
  GithubApiError,
  getUser,
  revokeUserToken,
  userInstallationRepos,
  userInstallations,
} from "./api.js";
import { githubKeys, openCredential, sealCredential } from "./crypto.js";
import { grantLinkedRepos } from "./grading.js";
import { FORBIDDEN_PERMISSIONS } from "./manifest.js";
import { FlowError, type GithubFlowEnv, settingsUrl, takeState } from "./setup.js";
import { addRepos, getApp, insertApp, linkInstallation, upsertInstallation } from "./store.js";
import { forgetWebhookSecret } from "./webhook.js";

const CODE = /^[A-Za-z0-9_-]{4,128}$/;

/** GET /github/manifest/callback?code&state → the App's credentials, sealed. */
export async function finishManifest(
  svc: Services,
  caller: Caller,
  query: { code?: string; state?: string },
): Promise<string> {
  const env = svc.env as GithubFlowEnv;
  const row = await takeState(svc, caller, "manifest", query.state);
  assertPlatformAdmin(caller, env);
  if (!query.code || !CODE.test(query.code)) throw new FlowError("code-missing");
  const kind = row.data.kind === "actor" ? "actor" : "reader";
  let app: Awaited<ReturnType<typeof convertManifest>>;
  try {
    app = await convertManifest(query.code);
  } catch (err) {
    throw new FlowError(err instanceof GithubApiError && err.status === 404 ? "code-expired" : "conversion-failed");
  }
  const keys = await githubKeys(env.GITHUB_APP_KEK);
  const now = svc.clock.now().toISOString();
  await insertApp(svc.store.db, {
    id: app.id,
    kind,
    slug: app.slug,
    name: app.name,
    ownerLogin: app.owner.login,
    ownerType: app.owner.type,
    clientId: app.client_id,
    htmlUrl: app.html_url,
    clientSecretEnc: await sealCredential(keys, app.id, "client_secret", app.client_secret),
    webhookSecretEnc: await sealCredential(keys, app.id, "webhook_secret", app.webhook_secret),
    pemEnc: await sealCredential(keys, app.id, "pem", app.pem),
    permissions: app.permissions,
    events: app.events,
    createdBy: caller.principal.id,
    createdAt: now,
    updatedAt: now,
  });
  forgetWebhookSecret(app.id);
  // Our manifests never ask for these; if GitHub reports one, the audit says so plainly.
  const unexpected: string[] = FORBIDDEN_PERMISSIONS.filter((p) => p in app.permissions);
  if (app.permissions.statuses === "write") unexpected.push("statuses:write");
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "github.app.created",
    subject: `github-app:${app.id}`,
    payload: {
      kind,
      slug: app.slug,
      owner: app.owner.login,
      permissions: app.permissions,
      events: app.events,
      unexpectedPermissions: unexpected,
    },
  });
  return settingsUrl({ created: app.slug });
}

/** GET /github/oauth/callback?code&state → verify the installation is the user's, then link. */
export async function finishSetup(
  svc: Services,
  caller: Caller,
  query: { code?: string; state?: string; error?: string },
): Promise<string> {
  const row = await takeState(svc, caller, "install", query.state);
  if (query.error) throw new FlowError("authorization-denied");
  if (!query.code || !CODE.test(query.code)) throw new FlowError("code-missing");
  const installationId = Number(row.data.installationId);
  const app = await getApp(svc.store.db, Number(row.data.appId));
  if (!app || !Number.isInteger(installationId)) throw new FlowError("no-app");
  const keys = await githubKeys((svc.env as GithubFlowEnv).GITHUB_APP_KEK);
  const clientSecret = await openCredential(keys, app.id, "client_secret", app.clientSecretEnc);
  let token: string;
  try {
    token = await exchangeUserCode({
      clientId: app.clientId,
      clientSecret,
      code: query.code,
      redirectUri: `${svc.origin}/github/oauth/callback`,
    });
  } catch {
    throw new FlowError("authorization-failed");
  }
  try {
    const user = await getUser(token);
    const mine = (await userInstallations(token)).find(
      (i) => i.id === installationId && i.app_id === app.id,
    );
    if (!mine || !mine.account) throw new FlowError("installation-not-yours");
    const now = svc.clock.now();
    await upsertInstallation(
      svc.store.db,
      {
        id: mine.id,
        appId: app.id,
        account: mine.account,
        repositorySelection: mine.repository_selection,
        permissions: mine.permissions,
        events: mine.events,
        suspendedAt: mine.suspended_at ?? null,
      },
      now,
    );
    const repos = await userInstallationRepos(token, mine.id);
    await addRepos(
      svc.store.db,
      mine.id,
      repos.map((r) => ({ id: r.id, fullName: r.full_name, private: r.private })),
      now,
    );
    await linkInstallation(svc.store.db, {
      installationId: mine.id,
      principalId: caller.principal.id,
      githubLogin: user.login,
      linkedAt: now.toISOString(),
    });
    // Repos of this installation already graded become visible to the person who linked it.
    await grantLinkedRepos(svc.store, mine.id, caller.principal.id);
    await svc.audit.append({
      principalId: caller.principal.id,
      action: "github.installation.linked",
      subject: `github-installation:${mine.id}`,
      payload: { appId: app.id, account: mine.account.login, githubLogin: user.login, repos: repos.length },
    });
    return settingsUrl({ linked: String(mine.id) });
  } catch (err) {
    if (err instanceof FlowError) throw err;
    throw new FlowError("github-error");
  } finally {
    // We only needed the token to verify; it is never stored.
    svc.waitUntil(revokeUserToken({ clientId: app.clientId, clientSecret, token }).catch(() => {}));
  }
}
