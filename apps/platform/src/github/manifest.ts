/**
 * GitHub App manifests (docs/research/github-app.md §7; DECISIONS 2026-10-03).
 *
 * - Reader App: public, shadow grading. Least privilege per spec §3.1 plus the read-only opt-ins
 *   the user approved: `merge_queues` (+`merge_group`), `deployments` (+`deployment_status`),
 *   `statuses` (+`status`). Never `statuses: write`, `administration` or `workflows`.
 * - Actor App: private, `gittifacts-actor-<org>`, created per customer through the same flow. Off
 *   until M5 (`GITHUB_ACTOR_APPS=on`).
 *
 * `request_oauth_on_install` stays false: GitHub ignores the setup URL when it is on ("you will not
 * be able to enter a URL here. Users will instead be redirected to the Callback URL"). The setup
 * URL sends the browser through a user authorization instead (src/github/setup.ts).
 */
import { z } from "zod";
import { GITHUB_WEB } from "./api.js";

export type AppKind = "reader" | "actor";

export const READER_PERMISSIONS = {
  metadata: "read",
  contents: "read",
  pull_requests: "write",
  checks: "write",
  issues: "read",
  merge_queues: "read",
  deployments: "read",
  statuses: "read",
} as const;

export const READER_EVENTS = [
  "pull_request",
  "pull_request_review",
  "check_run",
  "check_suite",
  "issues",
  "push",
  "merge_group",
  "deployment_status",
  "status",
] as const;

export const ACTOR_PERMISSIONS = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  checks: "read",
} as const;

export const ACTOR_EVENTS = ["pull_request", "pull_request_review"] as const;

/** Permissions we never request (stop-and-ask list). */
export const FORBIDDEN_PERMISSIONS = ["administration", "workflows"] as const;

/** GitHub org/user logins: alphanumerics and single hyphens, ≤ 39 chars. */
export const GithubLogin = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, "not a GitHub account name");

/** App names are global on GitHub and at most 34 characters. */
export const AppName = z
  .string()
  .trim()
  .min(1)
  .max(34, "GitHub App names are at most 34 characters")
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, "letters, digits, spaces, dots, dashes, underscores");

export const ManifestRequest = z.object({
  kind: z.enum(["reader", "actor"]).default("reader"),
  /** Create the App under this organization; omitted: under the signed-in GitHub user. */
  org: GithubLogin.optional(),
  name: AppName.optional(),
});
export type ManifestRequest = z.infer<typeof ManifestRequest>;

export function defaultAppName(kind: AppKind, org: string | undefined): string {
  if (kind === "reader") return "gittifacts";
  return `gittifacts-actor-${(org ?? "").toLowerCase()}`.replace(/-$/, "").slice(0, 34);
}

export interface Manifest {
  name: string;
  url: string;
  description: string;
  hook_attributes: { url: string; active: true };
  redirect_url: string;
  callback_urls: string[];
  setup_url: string;
  setup_on_update: true;
  request_oauth_on_install: false;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

export function buildManifest(kind: AppKind, origin: string, name: string): Manifest {
  const reader = kind === "reader";
  return {
    name,
    url: origin,
    description: reader
      ? "Grades every pull request: the cheapest review that is still safe. Shadow mode: posts one check run, merges nothing."
      : "Acts for gittifacts on the repositories you choose (Lane 0 merges, revert PRs). Private to your organization.",
    hook_attributes: { url: `${origin}/github/webhooks`, active: true },
    redirect_url: `${origin}/github/manifest/callback`,
    callback_urls: [`${origin}/github/oauth/callback`],
    setup_url: `${origin}/github/setup`,
    setup_on_update: true,
    request_oauth_on_install: false,
    public: reader,
    default_permissions: { ...(reader ? READER_PERMISSIONS : ACTOR_PERMISSIONS) },
    default_events: [...(reader ? READER_EVENTS : ACTOR_EVENTS)],
  };
}

/** Where the browser form-POSTs `manifest` (user account, or an organization). */
export function manifestAction(org: string | undefined, state: string): string {
  const base = org
    ? `${GITHUB_WEB}/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : `${GITHUB_WEB}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}
