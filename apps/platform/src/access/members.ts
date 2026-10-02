/**
 * Repo membership management: `GET/POST /api/v1/repos/{repoId}/members`,
 * `DELETE /api/v1/repos/{repoId}/members/{principalId}` and the read-only `list_members` tool.
 *
 * - Anyone who can read the repo sees who its members are (names and roles); owners also see
 *   e-mails (they add people by e-mail).
 * - Owners (humans) add an existing user by e-mail or a human principal by id, change roles and
 *   remove members. Only humans are members: agents act through their owner's role.
 * - A member may leave (remove themselves). The last owner can never be removed or demoted; the
 *   guard is in the SQL statement, so two owners removing each other at once cannot both win.
 * - Every change is audit-logged on `repo:<id>`.
 */
import { eq, inArray } from "drizzle-orm";
import type { Caller, Services } from "../app-env.js";
import { ensureHumanPrincipal } from "../auth/principals.js";
import { principals, user } from "../db/schema.js";
import { type ApiError, conflict, notFound } from "../errors.js";
import { assertRepoAccess, repoAccess } from "./access.js";
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
}

export interface MembersView {
  repoId: string;
  members: MemberView[];
  /** The caller's effective role on the repo. */
  viewerRole: RepoRole | null;
  /** True when the caller may add, change and remove members (a human owner). */
  canManage: boolean;
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
  const [refs, emails] = await Promise.all([
    svc.store.principalRefs(ids),
    canManage ? emailsOf(svc, ids) : Promise.resolve(new Map<string, string>()),
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
    })),
    viewerRole,
    canManage,
  };
}

function lastOwner(repoId: string): ApiError {
  return conflict(`that would leave repo ${repoId} without an owner`, "conflict", {
    explanation:
      "A repo always keeps at least one owner. Make someone else an owner first, then change or remove this one.",
  });
}

/** The human principal an owner names, by principal id or by a registered user's e-mail. */
async function targetHuman(
  svc: Services,
  who: { email?: string | undefined; principalId?: string | undefined },
): Promise<string> {
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
  if (!u) {
    throw notFound(`user with e-mail ${email}`, {
      explanation:
        "Nobody has signed up with that e-mail. Ask them to sign in once, then add them again.",
    });
  }
  const p = await ensureHumanPrincipal(
    svc.store,
    { id: u.id, email: u.email, name: u.name, image: u.image ?? null },
    svc.clock.now(),
  );
  return p.id;
}

/** Add a member, or change an existing member's role (owners only). */
export async function addMember(
  svc: Services,
  caller: Caller,
  repoId: string,
  body: { email?: string | undefined; principalId?: string | undefined; role: RepoRole },
): Promise<{ member: MemberView; created: boolean }> {
  await assertRepoAccess(svc, caller.principal, repoId, "admin");
  const principalId = await targetHuman(svc, body);
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
  return { member, created: previous === null };
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
