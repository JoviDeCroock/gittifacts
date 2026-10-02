/**
 * Principals: humans (one per better-auth user, created on first authenticated request),
 * agents (owned by a human, bearer tokens only) and the platform's `system` principal.
 */
import { INTEGRATION_ONLY_SCOPES, type Principal, Scope } from "@app/domain";
import { and, eq, isNull, or } from "drizzle-orm";
import { principals } from "../db/schema.js";
import type { D1Store } from "../store/d1-store.js";

/** Every scope except the integration-only ones (contents:read, webhooks, deployments:write, checks:write). */
export const DEFAULT_HUMAN_SCOPES: readonly Scope[] = Scope.options.filter(
  (s) => !INTEGRATION_ONLY_SCOPES.includes(s),
);

/**
 * What an agent may ever hold. Agents never approve plans, review changes, or administer policy:
 * "humans approve intent".
 */
export const AGENT_ALLOWED_SCOPES: readonly Scope[] = ["repo:read", "plan:create", "change:create"];

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
}

/** The human principal for a better-auth user, created with default scopes if missing. */
export async function ensureHumanPrincipal(
  store: D1Store,
  user: SessionUser,
  now: Date,
): Promise<Principal> {
  const existing = await store.db
    .select({ id: principals.id })
    .from(principals)
    .where(eq(principals.userId, user.id))
    .get();
  if (existing) {
    const p = await store.getPrincipal(existing.id);
    if (p) return p;
  }
  const id = `hu_${user.id}`.slice(0, 64);
  await store.db
    .insert(principals)
    .values({
      id,
      kind: "human",
      name: (user.name || user.email).slice(0, 120),
      ownerId: null,
      userId: user.id,
      scopes: [...DEFAULT_HUMAN_SCOPES],
      createdAt: now.toISOString(),
    })
    .onConflictDoNothing();
  const created = await store.getPrincipal(id);
  if (!created) throw new Error(`could not create principal for user ${user.id}`);
  return created;
}

export async function createAgentPrincipal(
  store: D1Store,
  input: {
    name: string;
    ownerId: string;
    scopes: Scope[];
    now: Date;
    /** Repos it may act on; null/omitted = every repo the owner can access. */
    repoIds?: readonly string[] | null;
  },
): Promise<Principal> {
  const notDelegable = input.scopes.filter((s) => !AGENT_ALLOWED_SCOPES.includes(s));
  if (notDelegable.length > 0) {
    // Last line of defence: no code path may persist an approval-class scope on an agent.
    throw new Error(`refusing to create an agent with ${notDelegable.join(", ")}`);
  }
  const id = `ag_${crypto.randomUUID().replaceAll("-", "")}`;
  await store.db.insert(principals).values({
    id,
    kind: "agent",
    name: input.name.slice(0, 120),
    ownerId: input.ownerId,
    userId: null,
    scopes: input.scopes,
    repoIds: input.repoIds ? [...input.repoIds] : null,
    createdAt: input.now.toISOString(),
  });
  const p = await store.getPrincipal(id);
  if (!p) throw new Error(`agent principal ${id} vanished after insert`);
  return p;
}

/** Disable a principal: every token it holds stops verifying at once (see verifyAgentToken). */
export async function disablePrincipal(store: D1Store, id: string, now: Date): Promise<boolean> {
  const rows = await store.db
    .update(principals)
    .set({ disabledAt: now.toISOString() })
    .where(and(eq(principals.id, id), isNull(principals.disabledAt)))
    .returning({ id: principals.id });
  return rows.length > 0;
}

/** The caller itself plus the agents it owns. */
export async function listVisiblePrincipals(
  store: D1Store,
  caller: Principal,
): Promise<Principal[]> {
  const rows = await store.db
    .select({ id: principals.id })
    .from(principals)
    .where(
      or(
        eq(principals.id, caller.id),
        and(eq(principals.ownerId, caller.id), eq(principals.kind, "agent")),
      ),
    )
    .all();
  const map = await store.getPrincipals(rows.map((r) => r.id));
  const list = [...map.values()];
  return [caller, ...list.filter((p) => p.id !== caller.id)];
}
