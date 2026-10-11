import type { Principal, Scope } from "@app/domain";
import type { z } from "zod";
import { canSeePrincipal, filterAccessible } from "../access/access.js";
import type { CreateAgentBody } from "../api/schemas.js";
import type { Caller, Services } from "../app-env.js";
import { issueAgentToken, revokeAgentTokens } from "../auth/agent-tokens.js";
import {
  AGENT_ALLOWED_SCOPES,
  createAgentPrincipal,
  listVisiblePrincipals,
} from "../auth/principals.js";
import { ApiError, forbidden, notFound } from "../errors.js";

/**
 * A principal by id, with its owner's name (for agents). Only principals the caller shares a repo
 * with (or its own, src/access/canSeePrincipal); anyone else is 404 like an unknown id.
 */
export async function getPrincipalDetail(
  svc: Services,
  caller: Caller,
  id: string,
): Promise<{ principal: Principal & { ownerName?: string } }> {
  const principal = await svc.store.getPrincipal(id);
  if (!principal || !(await canSeePrincipal(svc, caller.principal, principal))) {
    throw notFound(`principal ${id}`, { explanation: "No principal with that id." });
  }
  if (!principal.ownerId) return { principal };
  const owner = (await svc.store.principalRefs([principal.ownerId]))[principal.ownerId];
  return { principal: owner ? { ...principal, ownerName: owner.name } : principal };
}

export async function listPrincipals(svc: Services, caller: Caller): Promise<Principal[]> {
  return listVisiblePrincipals(svc.store, caller.principal);
}

/**
 * A human registers an agent it is accountable for. Requested scopes must be a subset of what
 * agents may hold and of what the human holds. The token is returned once.
 */
export async function createAgent(
  svc: Services,
  caller: Caller,
  body: z.infer<typeof CreateAgentBody>,
): Promise<{ principal: Principal; token: string }> {
  if (caller.principal.kind !== "human") throw forbidden("only a human may register an agent");
  const scopes = [...new Set(body.scopes)];
  const notForAgents = scopes.filter((s) => !AGENT_ALLOWED_SCOPES.includes(s));
  if (notForAgents.length > 0) {
    throw new ApiError(
      403,
      "scope-not-allowed",
      `agents may not hold: ${notForAgents.join(", ")}`,
      {
        allowed: AGENT_ALLOWED_SCOPES,
        rejected: notForAgents,
      },
    );
  }
  const notHeld = scopes.filter((s) => !caller.principal.scopes.includes(s));
  if (notHeld.length > 0) {
    throw new ApiError(
      403,
      "scope-not-allowed",
      `you cannot delegate scopes you do not hold: ${notHeld.join(", ")}`,
      {
        rejected: notHeld,
      },
    );
  }
  const repoIds = await grantableRepoIds(svc, caller, body.repoIds ?? null);
  const now = svc.clock.now();
  const principal = await createAgentPrincipal(svc.store, {
    name: body.name,
    ownerId: caller.principal.id,
    scopes: scopes as Scope[],
    now,
    repoIds,
  });
  const issued = await issueAgentToken(svc.store, {
    principalId: principal.id,
    scopes: principal.scopes,
    createdBy: caller.principal.id,
    expiresAt: new Date(now.getTime() + body.expiresInDays * 86_400_000),
    now,
  });
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "principal.agent-created",
    subject: `principal:${principal.id}`,
    payload: {
      name: principal.name,
      scopes: principal.scopes,
      repoIds,
      tokenId: issued.id,
      tokenPrefix: issued.prefix,
      expiresAt: issued.expiresAt,
    },
  });
  return { principal, token: issued.token };
}

/**
 * The repos a hand-made agent is limited to, checked like OAuth consent's picker: claimed repos the
 * creator can access. null (or omitted) keeps today's default, every repo the creator can reach.
 */
async function grantableRepoIds(
  svc: Services,
  caller: Caller,
  requested: readonly string[] | null,
): Promise<string[] | null> {
  if (requested === null) return null;
  const claimed = (await svc.store.listRepos()).filter((r) => r.claim.status === "claimed");
  const allowed = new Set(
    (await filterAccessible(svc, caller.principal, claimed)).map((r) => r.id),
  );
  const unique = [...new Set(requested)];
  const unknown = unique.filter((id) => !allowed.has(id));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      "invalid-request",
      `unknown or undelegable repo: ${unknown.join(", ")}`,
      {
        unknown,
      },
      {
        explanation:
          "Pick repos you are a member of (claimed repos you can access), or leave repoIds out for all of them.",
      },
    );
  }
  return unique;
}

/** Revoke all tokens of a principal: its owner, or the principal itself. */
export async function revokeTokens(
  svc: Services,
  caller: Caller,
  principalId: string,
): Promise<number> {
  const target = await svc.store.getPrincipal(principalId);
  if (!target) throw notFound(`principal ${principalId}`);
  const allowed = target.id === caller.principal.id || target.ownerId === caller.principal.id;
  if (!allowed) throw forbidden("only the principal or its owner may revoke its tokens");
  const revoked = await revokeAgentTokens(svc.store, target.id, svc.clock.now());
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "principal.tokens-revoked",
    subject: `principal:${target.id}`,
    payload: { revoked },
  });
  return revoked;
}
