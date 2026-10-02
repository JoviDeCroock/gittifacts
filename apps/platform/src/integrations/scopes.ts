/**
 * Integration permissions and webhook events, with the plain words the install screen shows.
 *
 * Least privilege: a deploy platform needs repo:read, contents:read, webhooks and
 * deployments:write. checks:write attaches external checks (raise-only). Nothing here can write
 * code, review, approve or merge: those scopes are not integration scopes at all, and
 * `parseIntegrationScopes` rejects them by name.
 */
import { IntegrationScope, type Scope } from "@app/domain";
import { z } from "zod";

export const INTEGRATION_SCOPES: readonly IntegrationScope[] = IntegrationScope.options;

/** What a deploy platform needs: the default when an integration registers without choosing. */
export const DEPLOY_PLATFORM_SCOPES: readonly IntegrationScope[] = [
  "repo:read",
  "contents:read",
  "webhooks",
  "deployments:write",
];

export const SCOPE_WORDS: Record<IntegrationScope, { title: string; description: string }> = {
  "repo:read": {
    title: "Read repository metadata",
    description: "See the repository's name, branches, commits, Changes and their status.",
  },
  "contents:read": {
    title: "Clone the code",
    description: "Clone and fetch the repository and its Change heads over git, read-only.",
  },
  webhooks: {
    title: "Receive events",
    description:
      "Get notified when the default branch or a Change is pushed, and when Changes are created, updated, merged or reverted.",
  },
  "deployments:write": {
    title: "Report deployments",
    description:
      "Post deployment status and preview URLs. A successful preview is attached to its Change as signed evidence.",
  },
  "checks:write": {
    title: "Report checks",
    description:
      "Attach external check results to Changes. They can only raise a Change's risk lane, never lower it.",
  },
};

/** What no integration can ever do, in the install screen's words. */
export const NEVER_WORDS: readonly string[] = [
  "Push code or write any branch",
  "Approve, review or merge Changes",
  "Change repository settings, policy or secrets",
  "See your agents' push tokens",
  "Connect to unclaimed projects",
];

export const ScopeExplainedSchema = z
  .object({ scope: IntegrationScope, title: z.string(), description: z.string() })
  .meta({ id: "IntegrationScopeExplained" });
export type ScopeExplained = z.infer<typeof ScopeExplainedSchema>;

export function explainScopes(scopes: readonly IntegrationScope[]): ScopeExplained[] {
  return INTEGRATION_SCOPES.filter((s) => scopes.includes(s)).map((scope) => ({
    scope,
    ...SCOPE_WORDS[scope],
  }));
}

export const WebhookEvent = z
  .enum([
    "push",
    "change.created",
    "change.updated",
    "change.merged",
    "change.reverted",
    "installation.created",
    "installation.deleted",
    "ping",
  ])
  .meta({ id: "WebhookEvent" });
export type WebhookEvent = z.infer<typeof WebhookEvent>;

/** Events an integration subscribes to by default (`ping` is always delivered). */
export const DEFAULT_EVENTS: readonly WebhookEvent[] = [
  "push",
  "change.created",
  "change.updated",
  "change.merged",
  "change.reverted",
  "installation.created",
  "installation.deleted",
];

export type IntegrationScopeParse =
  | { ok: true; scopes: IntegrationScope[] }
  | { ok: false; description: string };

/**
 * Parse an OAuth `scope` string from an integration client against what it registered. Empty =
 * everything it registered. Approval/write scopes are refused by name.
 */
export function parseIntegrationScopes(
  raw: string | null,
  registered: readonly IntegrationScope[],
): IntegrationScopeParse {
  const tokens = (raw ?? "").split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { ok: true, scopes: [...registered] };
  const out: IntegrationScope[] = [];
  for (const t of tokens) {
    const parsed = IntegrationScope.safeParse(t);
    if (!parsed.success) {
      return {
        ok: false,
        description: `integrations can never hold "${t}": they read code, receive events and report deployments and checks. Request a subset of ${registered.join(" ")}`,
      };
    }
    if (!registered.includes(parsed.data)) {
      return {
        ok: false,
        description: `"${t}" is not a permission this integration registered (${registered.join(" ")}); its developer can add it in the developer portal`,
      };
    }
    if (!out.includes(parsed.data)) out.push(parsed.data);
  }
  return { ok: true, scopes: out };
}

/** Narrow a stored scope list to integration scopes (anything else is dropped, fail closed). */
export function integrationScopesOf(raw: unknown): IntegrationScope[] {
  return z.array(z.string()).catch([]).parse(raw).filter((s): s is IntegrationScope =>
    IntegrationScope.safeParse(s).success,
  );
}

export function asScopes(scopes: readonly IntegrationScope[]): Scope[] {
  return [...scopes];
}
