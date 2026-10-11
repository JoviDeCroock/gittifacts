/**
 * Repo members (apps/platform/src/access/routes.ts): `GET/POST /api/v1/repos/:repoId/members`,
 * `DELETE /api/v1/repos/:repoId/members/:principalId`, and invites (an e-mail no verified account
 * has gets a single-use link: `/api/v1/invites/:token`). In mock mode an in-browser backend answers.
 */
import { request } from "./client.js";
import { isMockMode } from "./mode.js";

export type RepoRole = "owner" | "maintainer" | "reviewer" | "reader";

export const ROLES: readonly RepoRole[] = ["reader", "reviewer", "maintainer", "owner"];

/** What each role adds, in the words the members screen uses. */
export const ROLE_COPY: Record<RepoRole, { label: string; may: string }> = {
  reader: {
    label: "Reader",
    may: "Reads changes, evidence, walkthroughs and the audit trail. Their agents can only read.",
  },
  reviewer: {
    label: "Reviewer",
    may: "Reviews changes. Their agents draft plans and open changes.",
  },
  maintainer: {
    label: "Maintainer",
    may: "Approves plans and can pull the kill switch on a rollout.",
  },
  owner: { label: "Owner", may: "Manages members, the deploy target and Lane 0." },
};

export interface RepoMember {
  principalId: string;
  name: string;
  /** Shown to owners only. */
  email: string | null;
  role: RepoRole;
  addedBy: string;
  addedAt: string;
  /**
   * The agents this person runs: they act with this role here and lose access with it. Optional:
   * a server that does not send it yet leaves the line out (the screen fills in the viewer's own).
   */
  agents?: MemberAgent[];
}

export interface MemberAgent {
  principalId: string;
  name: string;
}

/** An open invite: the e-mail has not signed up and accepted yet. Owners only. */
export interface RepoInvite {
  id: string;
  email: string;
  role: RepoRole;
  invitedBy: { principalId: string; name: string };
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface MembersView {
  repoId: string;
  members: RepoMember[];
  viewerRole: RepoRole | null;
  canManage: boolean;
  /** Open invites (owners only; empty for everyone else). */
  invites: RepoInvite[];
}

/** Adding a signed-up person makes them a member; anyone else gets an invite link, shown once. */
export type AddMemberResult = { member: RepoMember } | { invite: RepoInvite; inviteUrl: string };

/** What an invite link offers (`GET /api/v1/invites/:token`, readable signed out). */
export interface InviteLink {
  status: "pending" | "accepted" | "expired" | "revoked";
  repo: { id: string; name: string };
  role: RepoRole;
  invitedBy: { name: string };
  emailHint: string;
  expiresAt: string;
  viewer: { signedIn: boolean; emailMatches: boolean; role: RepoRole | null };
}

export type AddMemberInput =
  | { email: string; role: RepoRole }
  | { principalId: string; role: RepoRole };

const enc = encodeURIComponent;

async function mock() {
  return import("./mock-members.js");
}

export const membersApi = {
  list: async (repoId: string): Promise<MembersView> =>
    isMockMode()
      ? (await mock()).listMembers(repoId)
      : request<MembersView>("GET", `/api/v1/repos/${enc(repoId)}/members`),
  add: async (repoId: string, input: AddMemberInput, key?: string): Promise<AddMemberResult> =>
    isMockMode()
      ? (await mock()).addMember(repoId, input)
      : request<AddMemberResult>("POST", `/api/v1/repos/${enc(repoId)}/members`, input, key),
  revokeInvite: async (
    repoId: string,
    inviteId: string,
    key?: string,
  ): Promise<{ revoked: true; inviteId: string }> =>
    isMockMode()
      ? (await mock()).revokeInvite(repoId, inviteId)
      : request<{ revoked: true; inviteId: string }>(
          "DELETE",
          `/api/v1/repos/${enc(repoId)}/invites/${enc(inviteId)}`,
          undefined,
          key,
        ),
  inviteLink: (token: string): Promise<InviteLink> =>
    request<InviteLink>("GET", `/api/v1/invites/${enc(token)}`),
  acceptInvite: (
    token: string,
    key?: string,
  ): Promise<{ repoId: string; role: RepoRole; alreadyMember: boolean }> =>
    request("POST", `/api/v1/invites/${enc(token)}/accept`, undefined, key),
  remove: async (
    repoId: string,
    principalId: string,
    key?: string,
  ): Promise<{ removed: true; principalId: string }> =>
    isMockMode()
      ? (await mock()).removeMember(repoId, principalId)
      : request<{ removed: true; principalId: string }>(
          "DELETE",
          `/api/v1/repos/${enc(repoId)}/members/${enc(principalId)}`,
          undefined,
          key,
        ),
};
