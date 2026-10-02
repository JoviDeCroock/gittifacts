/**
 * The principal behind an unclaimed project: an agent no human owns yet (`ownerId: null`), with
 * the agent scopes only (repo:read, plan:create, change:create — never an approval scope) and
 * limited to the one project it created (`repoIds`). Its Bearer token lives exactly as long as
 * the project. Claiming sets `ownerId` to the human; scopes and repos stay as they are.
 */
import type { Principal, Scope } from "@app/domain";
import { eq } from "drizzle-orm";
import { issueAgentToken } from "../auth/agent-tokens.js";
import { AGENT_ALLOWED_SCOPES } from "../auth/principals.js";
import { principals } from "../db/schema.js";
import type { D1Store } from "../store/d1-store.js";

export const UNCLAIMED_AGENT_SCOPES: Scope[] = ["repo:read", "plan:create", "change:create"];

export async function createUnclaimedAgent(
  store: D1Store,
  input: { label: string; now: Date },
): Promise<Principal> {
  // Same last line of defence as createAgentPrincipal: never an approval-class scope.
  if (UNCLAIMED_AGENT_SCOPES.some((s) => !AGENT_ALLOWED_SCOPES.includes(s))) {
    throw new Error("unclaimed agents may only hold delegable agent scopes");
  }
  const id = `ag_${crypto.randomUUID().replaceAll("-", "")}`;
  await store.db.insert(principals).values({
    id,
    kind: "agent",
    name: `Unclaimed agent (${input.label})`.slice(0, 120),
    ownerId: null,
    userId: null,
    scopes: [...UNCLAIMED_AGENT_SCOPES],
    // No repo until its project exists: an empty list grants nothing.
    repoIds: [],
    createdAt: input.now.toISOString(),
  });
  const p = await store.getPrincipal(id);
  if (!p) throw new Error(`unclaimed agent ${id} vanished after insert`);
  return p;
}

/** Limit the agent to its project (one repo, for good). */
export async function bindAgentToRepo(store: D1Store, principalId: string, repoId: string) {
  await store.db
    .update(principals)
    .set({ repoIds: [repoId] })
    .where(eq(principals.id, principalId));
}

/** The project's Bearer token: the agent scopes, valid until the project expires. */
export async function issueProjectToken(
  store: D1Store,
  principalId: string,
  expiresAt: Date,
  now: Date,
): Promise<string> {
  const issued = await issueAgentToken(store, {
    principalId,
    scopes: [...UNCLAIMED_AGENT_SCOPES],
    createdBy: principalId,
    expiresAt,
    now,
  });
  return issued.token;
}
