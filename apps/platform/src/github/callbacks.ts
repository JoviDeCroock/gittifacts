/** GitHub's redirect back to us after the App's user authorization (install verification). */
import type { Caller, Services } from "../app-env.js";
import {
  exchangeUserCode,
  getUser,
  revokeUserToken,
  userInstallationRepos,
  userInstallations,
} from "./api.js";
import { githubApp } from "./app-config.js";
import { grantLinkedRepos } from "./grading.js";
import { FlowError, settingsUrl, takeState } from "./setup.js";
import { addRepos, linkInstallation, upsertInstallation } from "./store.js";

const CODE = /^[A-Za-z0-9_-]{4,128}$/;

/** GET /github/oauth/callback?code&state → verify the installation is the user's, then link. */
export async function finishSetup(
  svc: Services,
  caller: Caller,
  query: { code?: string; state?: string; error?: string },
  nonce: string | undefined,
): Promise<string> {
  const state = await takeState(svc, caller, query.state, nonce);
  if (query.error) throw new FlowError("authorization-denied");
  if (!query.code || !CODE.test(query.code)) throw new FlowError("code-missing");
  const installationId = state.installationId;
  const app = githubApp(svc.env as unknown as Record<string, unknown>);
  if (app === null) throw new FlowError("not-configured");
  const clientSecret = app.clientSecret;
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
      (i) => i.id === installationId && i.app_id === app.appId,
    );
    if (!mine || !mine.account) throw new FlowError("installation-not-yours");
    const now = svc.clock.now();
    await upsertInstallation(
      svc.store.db,
      {
        id: mine.id,
        appId: app.appId,
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
      payload: {
        appId: app.appId,
        account: mine.account.login,
        githubLogin: user.login,
        repos: repos.length,
      },
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
