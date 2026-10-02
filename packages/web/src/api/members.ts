/**
 * Repo members (apps/platform/src/access/routes.ts): `GET/POST /api/v1/repos/:repoId/members`,
 * `DELETE /api/v1/repos/:repoId/members/:principalId`. In mock mode an in-browser backend answers.
 */
import { request } from "./client.js";
import { isMockMode } from "./mode.js";

export type RepoRole = "owner" | "maintainer" | "reviewer" | "reader";

export const ROLES: readonly RepoRole[] = ["reader", "reviewer", "maintainer", "owner"];

/** What each role adds, in the words the members screen uses. */
export const ROLE_COPY: Record<RepoRole, { label: string; may: string }> = {
  reader: {
    label: "Reader",
    may: "Reads changes, evidence, tours and the audit trail. Their agents can only read.",
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
}

export interface MembersView {
  repoId: string;
  members: RepoMember[];
  viewerRole: RepoRole | null;
  canManage: boolean;
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
  add: async (
    repoId: string,
    input: AddMemberInput,
    key?: string,
  ): Promise<{ member: RepoMember }> =>
    isMockMode()
      ? (await mock()).addMember(repoId, input)
      : request<{ member: RepoMember }>("POST", `/api/v1/repos/${enc(repoId)}/members`, input, key),
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
