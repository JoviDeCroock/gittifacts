/**
 * Repo membership management: `GET/POST /api/v1/repos/{repoId}/members`,
 * `DELETE /api/v1/repos/{repoId}/members/{principalId}` and the read-only `list_members` tool.
 *
 * - Anyone who can read the repo sees who its members are (names and roles); owners also see
 *   e-mails (they add people by e-mail).
 * - Owners (humans) add an existing user by verified e-mail or a human principal by id, change
 *   roles and remove members. Only humans are members: agents act through their owner's role.
 * - A member may leave (remove themselves). The last owner can never be removed or demoted; the
 *   guard is in the SQL statement, so two owners removing each other at once cannot both win.
 * - Any other e-mail (nobody signed up with it, or its account's e-mail is unverified) becomes a
 *   pending invite with a single-use link (./invites.ts); owners see open invites in the list.
 * - Every change is audit-logged on `repo:<id>`.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Caller, Services } from "../app-env.js";
import { ensureHumanPrincipal } from "../auth/principals.js";
import { principals, user } from "../db/schema.js";
import { type ApiError, conflict, notFound } from "../errors.js";
import { assertRepoAccess, repoAccess } from "./access.js";
import { createInvite, type InviteView, openInviteViews, supersedeInvites } from "./invites.js";
import {
  changeRoleRow,
  listMemberRows,
  memberRole,
  putMember,
  removeMemberRow,
} from "./members-store.js";
import type { RepoRole } from "./roles.js";

export interface MemberView {
  principalId: string;
  name: string;
  /** Only shown to the repo's owners. */
  email: string | null;
  role: RepoRole;
  addedBy: string;
  addedAt: string;
  /** The agents this member owns that may act here (with this member's role; not revoked). */
  agents: { principalId: string; name: string }[];
}

export interface MembersView {
  repoId: string;
  members: MemberView[];
  /** The caller's effective role on the repo. */
  viewerRole: RepoRole | null;
  /** True when the caller may add, change and remove members (a human owner). */
  canManage: boolean;
  /** Open invites (owners only; empty for everyone else). */
  invites: InviteView[];
}

/** Each owner's live agents that may act on `repoId` (no repo grant, or one that names it). */
async function agentsOf(
  svc: Services,
  ownerIds: string[],
  repoId: string,
): Promise<Map<string, { principalId: string; name: string }[]>> {
  const out = new Map<string, { principalId: string; name: string }[]>();
  for (let i = 0; i < ownerIds.length; i += 90) {
    const rows = await svc.store.db
      .select({
        id: principals.id,
        name: principals.name,
        ownerId: principals.ownerId,
        repoIds: principals.repoIds,
      })
      .from(principals)
      .where(
        and(
          inArray(principals.ownerId, ownerIds.slice(i, i + 90)),
          eq(principals.kind, "agent"),
          isNull(principals.disabledAt),
        ),
      )
      .all();
    for (const r of rows) {
      if (r.ownerId === null || (r.repoIds !== null && !r.repoIds.includes(repoId))) continue;
      const list = out.get(r.ownerId) ?? [];
      list.push({ principalId: r.id, name: r.name });
      out.set(r.ownerId, list);
    }
  }
  return out;
}

async function emailsOf(svc: Services, principalIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (principalIds.length === 0) return out;
  const rows = await svc.store.db
    .select({ id: principals.id, email: user.email })
    .from(principals)
    .innerJoin(user, eq(user.id, principals.userId))
    .where(inArray(principals.id, principalIds.slice(0, 90)))
    .all();
  for (const r of rows) out.set(r.id, r.email);
  return out;
}

export async function listMembers(
  svc: Services,
  caller: Caller,
  repoId: string,
): Promise<MembersView> {
  const repo = await assertRepoAccess(svc, caller.principal, repoId, "read");
  const rows = await listMemberRows(svc.store, repoId);
  const viewerRole = (await repoAccess(svc, caller.principal, repo)).role;
  const canManage = caller.principal.kind === "human" && viewerRole === "owner";
  const ids = rows.map((r) => r.principalId);
  const [refs, emails, agents, invites] = await Promise.all([
    svc.store.principalRefs(ids),
    canManage ? emailsOf(svc, ids) : Promise.resolve(new Map<string, string>()),
    agentsOf(svc, ids, repoId),
    canManage ? openInviteViews(svc, repoId) : Promise.resolve([]),
  ]);
  return {
    repoId,
    members: rows.map((r) => ({
      principalId: r.principalId,
      name: refs[r.principalId]?.name ?? r.principalId,
      email: emails.get(r.principalId) ?? null,
      role: r.role,
      addedBy: r.addedBy,
      addedAt: r.addedAt,
      agents: agents.get(r.principalId) ?? [],
    })),
    viewerRole,
    canManage,
    invites,
  };
}

function lastOwner(repoId: string): ApiError {
  return conflict(`that would leave repo ${repoId} without an owner`, "conflict", {
    explanation:
      "A repo always keeps at least one owner. Make someone else an owner first, then change or remove this one.",
  });
}

/**
 * The human principal an owner names, by principal id or by the e-mail of an account whose e-mail
 * is verified; null otherwise (the caller invites them instead). E-mail sign-up doesn't prove the
 * address (nothing is mailed), so an unverified account's e-mail may belong to someone else: whoever
 * pre-registered bob@corp.com must not receive the role meant for Bob (security audit 2026-10-11,
 * M3). The invite link, handed to the person the owner means, is the proof then.
 */
async function targetHuman(
  svc: Services,
  who: { email?: string | undefined; principalId?: string | undefined },
): Promise<string | null> {
  if (who.principalId !== undefined) {
    const p = await svc.store.getPrincipal(who.principalId);
    if (p?.kind !== "human") {
      throw notFound(`human principal ${who.principalId}`, {
        explanation:
          "Only humans are repo members (agents act with their owner's role). Use the principal id of a person (hu_…), or their e-mail.",
      });
    }
    return p.id;
  }
  const email = (who.email ?? "").trim().toLowerCase();
  const u = await svc.store.db.select().from(user).where(eq(user.email, email)).get();
  if (!u?.emailVerified) return null;
  const p = await ensureHumanPrincipal(
    svc.store,
    { id: u.id, email: u.email, name: u.name, image: u.image ?? null },
    svc.clock.now(),
  );
  return p.id;
}

export type AddMemberResult =
  | { kind: "member"; member: MemberView; created: boolean }
  | { kind: "invite"; invite: InviteView; inviteUrl: string };

/**
 * Add a member, change an existing member's role, or invite an e-mail no verified account has
 * (owners only).
 */
export async function addMember(
  svc: Services,
  caller: Caller,
  repoId: string,
  body: { email?: string | undefined; principalId?: string | undefined; role: RepoRole },
): Promise<AddMemberResult> {
  await assertRepoAccess(svc, caller.principal, repoId, "admin");
  const principalId = await targetHuman(svc, body);
  if (principalId === null) {
    const invited = await createInvite(svc, caller, repoId, body.email ?? "", body.role);
    return { kind: "invite", ...invited };
  }
  if (body.email !== undefined) await supersedeInvites(svc, repoId, body.email);
  const previous = await memberRole(svc.store, repoId, principalId);
  const row = {
    repoId,
    principalId,
    role: body.role,
    addedBy: caller.principal.id,
    addedAt: svc.clock.now().toISOString(),
  };
  if (previous === null) await putMember(svc.store, row);
  else if (previous !== body.role && !(await changeRoleRow(svc.store, row))) {
    throw lastOwner(repoId);
  }
  if (previous !== body.role) {
    await svc.audit.append({
      principalId: caller.principal.id,
      action: previous === null ? "repo.member-added" : "repo.member-role-changed",
      subject: `repo:${repoId}`,
      payload: { memberId: principalId, role: body.role, previousRole: previous },
    });
  }
  const view = await listMembers(svc, caller, repoId);
  const member = view.members.find((m) => m.principalId === principalId);
  if (!member) throw new Error(`member ${principalId} vanished after the write`);
  return { kind: "member", member, created: previous === null };
}

/** Remove a member (owners), or leave the repo (any member removing itself). */
export async function removeMember(
  svc: Services,
  caller: Caller,
  repoId: string,
  principalId: string,
): Promise<{ removed: true; principalId: string }> {
  const self = principalId === caller.principal.id;
  await assertRepoAccess(svc, caller.principal, repoId, self ? "read" : "admin");
  const previous = await memberRole(svc.store, repoId, principalId);
  if (previous === null) {
    throw notFound(`member ${principalId} of repo ${repoId}`, {
      explanation: "That principal is not a member of this repo. List the members first.",
      call: `list_members({ repoId: "${repoId}" })`,
    });
  }
  if (!(await removeMemberRow(svc.store, repoId, principalId))) throw lastOwner(repoId);
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "repo.member-removed",
    subject: `repo:${repoId}`,
    payload: { memberId: principalId, previousRole: previous, left: self },
  });
  return { removed: true, principalId };
}
