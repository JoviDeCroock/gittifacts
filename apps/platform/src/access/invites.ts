/**
 * Member invites for people who have not signed up yet (DECISIONS 2026-10-11).
 *
 * - An owner adding an e-mail nobody has signed up with gets a single-use invite link
 *   (`/invite/gtm_…`), shown once. There is no e-mail sending; the owner hands the link over.
 * - Accepting needs the link AND a signed-in person whose account e-mail is the invited one.
 *   Neither alone is enough: e-mail sign-up does not prove the address (no mail is sent), and a
 *   forwarded link must not admit whoever opens it.
 * - The inviter must still be an owner when the invite is accepted.
 * - Owners list and revoke open invites; inviting the same e-mail again replaces the link.
 * - Audited on `repo:<id>`: member.invited, member.invite-accepted, member.invite-revoked.
 */
import type { Principal } from "@app/domain";
import type { Caller, Services } from "../app-env.js";
import { ApiError, conflict, notFound } from "../errors.js";
import { assertRepoAccess } from "./access.js";
import {
  hashInviteToken,
  INVITE_TTL_MS,
  type InviteRow,
  insertInvite,
  inviteById,
  inviteByTokenHash,
  inviteUrlFor,
  isInviteTokenShape,
  listOpenInvites,
  markAccepted,
  newInviteToken,
  normalizeEmail,
  revokeOpenInvites,
} from "./invites-store.js";
import { memberRole, putMember } from "./members-store.js";
import type { RepoRole } from "./roles.js";

export interface InviteView {
  id: string;
  email: string;
  role: RepoRole;
  invitedBy: { principalId: string; name: string };
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

/** `ada@example.com` → `ad•••@example.com`: enough to pick the right account, not to harvest. */
export function emailHint(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email.slice(0, Math.min(2, at))}•••${email.slice(at)}`;
}

async function views(svc: Services, rows: InviteRow[]): Promise<InviteView[]> {
  const refs = await svc.store.principalRefs(rows.map((r) => r.invitedBy));
  const now = svc.clock.now().toISOString();
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    invitedBy: { principalId: r.invitedBy, name: refs[r.invitedBy]?.name ?? r.invitedBy },
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    expired: r.expiresAt <= now,
  }));
}

/** Open invites of a repo (the caller already holds `admin`). */
export async function openInviteViews(svc: Services, repoId: string): Promise<InviteView[]> {
  return views(svc, await listOpenInvites(svc.store, repoId));
}

/** Invite an e-mail nobody has signed up with (the caller already holds `admin`). */
export async function createInvite(
  svc: Services,
  caller: Caller,
  repoId: string,
  rawEmail: string,
  role: RepoRole,
): Promise<{ invite: InviteView; inviteUrl: string }> {
  const email = normalizeEmail(rawEmail);
  const now = svc.clock.now();
  const at = now.toISOString();
  const replaced = await revokeOpenInvites(svc.store, { repoId, email }, at);
  const token = newInviteToken();
  const row = {
    id: `inv_${crypto.randomUUID().replaceAll("-", "")}`,
    repoId,
    email,
    role,
    invitedBy: caller.principal.id,
    createdAt: at,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
  };
  await insertInvite(svc.store, row, await hashInviteToken(token));
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "member.invited",
    subject: `repo:${repoId}`,
    payload: { inviteId: row.id, emailHint: emailHint(email), role, replaced },
  });
  const [invite] = await views(svc, [{ ...row, acceptedAt: null, acceptedBy: null, revokedAt: null }]);
  if (!invite) throw new Error(`invite ${row.id} has no view`);
  return { invite, inviteUrl: inviteUrlFor(svc.origin, token) };
}

/** Revoke an open invite (owners). The link stops working at once. */
export async function revokeInvite(
  svc: Services,
  caller: Caller,
  repoId: string,
  inviteId: string,
): Promise<{ revoked: true; inviteId: string }> {
  await assertRepoAccess(svc, caller.principal, repoId, "admin");
  const row = await inviteById(svc.store, repoId, inviteId);
  const gone = await revokeOpenInvites(svc.store, { repoId, id: inviteId }, svc.clock.now().toISOString());
  if (!row || gone.length === 0) {
    throw notFound(`open invite ${inviteId} of repo ${repoId}`, {
      explanation: "That invite was already accepted or revoked, or never existed. List the members to see open invites.",
    });
  }
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "member.invite-revoked",
    subject: `repo:${repoId}`,
    payload: { inviteId, emailHint: emailHint(row.email), role: row.role },
  });
  return { revoked: true, inviteId };
}

/** An owner added someone directly: any open invite for their e-mail is moot. */
export async function supersedeInvites(svc: Services, repoId: string, email: string): Promise<void> {
  await revokeOpenInvites(svc.store, { repoId, email: normalizeEmail(email) }, svc.clock.now().toISOString());
}

export type InviteStatus = "pending" | "accepted" | "expired" | "revoked";

export interface InviteLinkView {
  status: InviteStatus;
  repo: { id: string; name: string };
  role: RepoRole;
  invitedBy: { name: string };
  /** The invited e-mail, partly hidden: the link may have been forwarded. */
  emailHint: string;
  expiresAt: string;
  viewer: {
    signedIn: boolean;
    /** The signed-in person's e-mail is the invited one. */
    emailMatches: boolean;
    /** The signed-in person's role on the repo, if they are a member already. */
    role: RepoRole | null;
  };
}

function badLink(): ApiError {
  return notFound("invite", {
    explanation:
      "This invite link doesn't work. Check you copied all of it, or ask the repo's owner for a new one.",
  });
}

async function rowForToken(svc: Services, token: string): Promise<InviteRow> {
  if (!isInviteTokenShape(token)) throw badLink();
  const row = await inviteByTokenHash(svc.store, await hashInviteToken(token));
  if (!row) throw badLink();
  return row;
}

function statusOf(row: InviteRow, now: string): InviteStatus {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  return row.expiresAt <= now ? "expired" : "pending";
}

/** What an invite link offers (no sign-in needed: the link itself is the secret). */
export async function getInviteLink(
  svc: Services,
  caller: Caller | null,
  token: string,
): Promise<InviteLinkView> {
  const row = await rowForToken(svc, token);
  const [repo, refs] = await Promise.all([
    svc.store.getRepo(row.repoId),
    svc.store.principalRefs([row.invitedBy]),
  ]);
  if (!repo) throw badLink();
  const human = caller?.principal.kind === "human" ? caller : null;
  return {
    status: statusOf(row, svc.clock.now().toISOString()),
    repo: { id: repo.id, name: repo.name },
    role: row.role,
    invitedBy: { name: refs[row.invitedBy]?.name ?? "An owner" },
    emailHint: emailHint(row.email),
    expiresAt: row.expiresAt,
    viewer: {
      signedIn: human !== null,
      emailMatches: human?.user ? normalizeEmail(human.user.email) === row.email : false,
      role: human ? await memberRole(svc.store, row.repoId, human.principal.id) : null,
    },
  };
}

function gone(status: InviteStatus): ApiError {
  const why = {
    accepted: "This invite was already used. An invite link works once.",
    revoked: "An owner revoked this invite.",
    expired: "This invite expired. Invite links work for a week.",
    pending: "",
  }[status];
  return new ApiError(409, "invite-closed", `invite is ${status}`, { status }, {
    explanation: `${why} Ask the repo's owner to add you again; they get a new link.`,
  });
}

/** A signed-in person accepts an invite with the link and their matching account e-mail. */
export async function acceptInvite(
  svc: Services,
  caller: Caller,
  token: string,
): Promise<{ repoId: string; role: RepoRole; alreadyMember: boolean }> {
  const row = await rowForToken(svc, token);
  const me: Principal = caller.principal;
  const at = svc.clock.now().toISOString();
  const status = statusOf(row, at);
  if (status === "accepted" && row.acceptedBy === me.id) {
    const role = await memberRole(svc.store, row.repoId, me.id);
    if (role) return { repoId: row.repoId, role, alreadyMember: true };
  }
  if (status !== "pending") throw gone(status);
  if (!caller.user || normalizeEmail(caller.user.email) !== row.email) {
    throw new ApiError(403, "invite-email-mismatch", "this invite is for another e-mail", {
      invitedEmail: emailHint(row.email),
    }, {
      explanation: `This invite is for ${emailHint(row.email)}. Sign out, then sign in or create an account with that e-mail and open the link again.`,
    });
  }
  if ((await memberRole(svc.store, row.repoId, row.invitedBy)) !== "owner") {
    throw conflict("the person who sent this invite is no longer an owner", "invite-closed", {
      explanation: "Invites only work while their sender owns the repo. Ask a current owner to add you.",
    });
  }
  if (!(await markAccepted(svc.store, row.id, me.id, at))) throw gone("accepted");
  const existing = await memberRole(svc.store, row.repoId, me.id);
  // Already a member (an owner added them directly meanwhile): keep the role they have.
  if (existing === null) {
    await putMember(svc.store, {
      repoId: row.repoId,
      principalId: me.id,
      role: row.role,
      addedBy: row.invitedBy,
      addedAt: at,
    });
  }
  await svc.audit.append({
    principalId: me.id,
    action: "member.invite-accepted",
    subject: `repo:${row.repoId}`,
    payload: { inviteId: row.id, role: existing ?? row.role, invitedBy: row.invitedBy, alreadyMember: existing !== null },
  });
  return { repoId: row.repoId, role: existing ?? row.role, alreadyMember: existing !== null };
}
