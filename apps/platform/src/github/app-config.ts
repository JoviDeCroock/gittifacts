/**
 * The platform's GitHub Apps, from Worker config (DECISIONS 2026-10-03, "GitHub Apps are created by
 * hand"): the user registers each App on GitHub once and sets its values the standard way. Nothing
 * about an App is stored in D1, and no in-app flow can register another App we'd trust.
 *
 *   Reader App (shadow grading, PR writes)        Actor App (M5: Lane 0 merges, revert PRs)
 *   vars:    GITHUB_APP_ID                        GITHUB_ACTOR_APP_ID
 *            GITHUB_APP_SLUG                      GITHUB_ACTOR_APP_SLUG
 *            GITHUB_APP_CLIENT_ID                 GITHUB_ACTOR_APP_CLIENT_ID
 *   secrets: GITHUB_APP_PRIVATE_KEY               GITHUB_ACTOR_APP_PRIVATE_KEY      (GitHub's PEM)
 *            GITHUB_APP_WEBHOOK_SECRET            GITHUB_ACTOR_APP_WEBHOOK_SECRET
 *            GITHUB_APP_CLIENT_SECRET             GITHUB_ACTOR_APP_CLIENT_SECRET
 *   optional GITHUB_APP_WEBHOOK_SECRET_PREVIOUS   GITHUB_ACTOR_APP_WEBHOOK_SECRET_PREVIOUS (rotation)
 *
 * Anything missing: GitHub mode is "not configured" (the API and /settings/github say which names
 * are missing, never their values; the webhook answers 503).
 */
import { GITHUB_WEB } from "./api.js";

export type AppKind = "reader" | "actor";

export interface GithubAppConfig {
  kind: AppKind;
  appId: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  /** PEM (GitHub's PKCS#1, or PKCS#8). */
  privateKey: string;
  /** The current webhook secret first, then the previous one during a rotation. */
  webhookSecrets: string[];
}

type Env = Record<string, unknown>;

const PREFIX: Record<AppKind, string> = { reader: "GITHUB_APP", actor: "GITHUB_ACTOR_APP" };
const REQUIRED = [
  "ID",
  "SLUG",
  "CLIENT_ID",
  "PRIVATE_KEY",
  "WEBHOOK_SECRET",
  "CLIENT_SECRET",
] as const;

const str = (env: Env, name: string): string => {
  const v = env[name];
  return typeof v === "string" ? v.trim() : "";
};

/** Names (never values) the App still needs. */
export function missingConfig(env: Env, kind: AppKind = "reader"): string[] {
  const p = PREFIX[kind];
  const missing = REQUIRED.map((k) => `${p}_${k}`).filter((n) => str(env, n) === "");
  if (str(env, `${p}_ID`) !== "" && !/^\d{1,12}$/.test(str(env, `${p}_ID`)))
    missing.push(`${p}_ID (a number)`);
  return missing;
}

/** The App's config, or null when anything is missing. */
export function githubApp(env: Env, kind: AppKind = "reader"): GithubAppConfig | null {
  if (missingConfig(env, kind).length > 0) return null;
  const p = PREFIX[kind];
  const previous = str(env, `${p}_WEBHOOK_SECRET_PREVIOUS`);
  return {
    kind,
    appId: Number(str(env, `${p}_ID`)),
    slug: str(env, `${p}_SLUG`),
    clientId: str(env, `${p}_CLIENT_ID`),
    clientSecret: str(env, `${p}_CLIENT_SECRET`),
    // A PEM pasted as one line keeps its newlines as "\n".
    privateKey: str(env, `${p}_PRIVATE_KEY`).replace(/\\n/g, "\n"),
    webhookSecrets: [str(env, `${p}_WEBHOOK_SECRET`), ...(previous === "" ? [] : [previous])],
  };
}

/** The configured App with this id (webhooks, installations), or null. */
export function appForId(env: Env, appId: number): GithubAppConfig | null {
  for (const kind of ["reader", "actor"] as const) {
    const app = githubApp(env, kind);
    if (app !== null && app.appId === appId) return app;
  }
  return null;
}

export const installUrl = (slug: string) => `${GITHUB_WEB}/apps/${slug}/installations/new`;
export const appUrl = (slug: string) => `${GITHUB_WEB}/apps/${slug}`;
