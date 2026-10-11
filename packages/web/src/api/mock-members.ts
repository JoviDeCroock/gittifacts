/**
 * In-browser members backend for mock mode: Maya owns every demo repo, Dev maintains, Lena reviews.
 * Same rules as the platform: owners manage, a member may leave, the last owner stays.
 */
import { ApiError } from "./client.js";
import { ME, principals } from "./fixtures.js";
import type {
  AddMemberInput,
  AddMemberResult,
  MembersView,
  RepoInvite,
  RepoMember,
  RepoRole,
} from "./members.js";

const PEOPLE: Record<string, { name: string; email: string }> = {
  prn_maya: { name: "Maya Okafor", email: "maya@acme.dev" },
  prn_dev: { name: "Dev Patel", email: "dev@acme.dev" },
  prn_lena: { name: "Lena Brandt", email: "lena@acme.dev" },
  prn_sam: { name: "Sam Reyes", email: "sam@acme.dev" },
};

const byRepo = new Map<string, RepoMember[]>();
const invitesByRepo = new Map<string, RepoInvite[]>();

function iso(minAgo: number): string {
  return new Date(Date.now() - minAgo * 60_000).toISOString();
}

function member(id: string, role: RepoRole, minAgo: number): RepoMember {
  const p = PEOPLE[id] ?? { name: id, email: `${id}@acme.dev` };
  return { principalId: id, name: p.name, email: p.email, role, addedBy: ME, addedAt: iso(minAgo) };
}

function rows(repoId: string): RepoMember[] {
  let r = byRepo.get(repoId);
  if (!r) {
    r = [
      member(ME, "owner", 90_000),
      member("prn_dev", "maintainer", 60_000),
      member("prn_lena", "reviewer", 20_000),
    ];
    byRepo.set(repoId, r);
  }
  return r;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The demo agents each person runs (fixtures: fleet-coder-07, planner-02 and issue-triager are Maya's). */
function agentsOf(personId: string) {
  return principals()
    .filter((p) => p.kind === "agent" && p.ownerId === personId)
    .map((p) => ({ principalId: p.id, name: p.name }));
}

function view(repoId: string): MembersView {
  const all = rows(repoId);
  const viewerRole = all.find((m) => m.principalId === ME)?.role ?? null;
  const canManage = viewerRole === "owner";
  return {
    repoId,
    members: all.map((m) => ({ ...m, email: canManage ? m.email : null, agents: agentsOf(m.principalId) })),
    viewerRole,
    canManage,
    invites: canManage ? [...(invitesByRepo.get(repoId) ?? [])] : [],
  };
}

function lastOwner(): ApiError {
  return new ApiError(
    409,
    "conflict",
    "That would leave the repository without an owner.",
    undefined,
    {
      explanation:
        "A repository always keeps at least one owner. Make someone else an owner first.",
    },
  );
}

export async function listMembers(repoId: string): Promise<MembersView> {
  await wait(160);
  return view(repoId);
}

export async function addMember(
  repoId: string,
  input: AddMemberInput,
): Promise<AddMemberResult> {
  await wait(420);
  const all = rows(repoId);
  const id =
    "principalId" in input
      ? input.principalId
      : Object.entries(PEOPLE).find(([, p]) => p.email === input.email.trim().toLowerCase())?.[0];
  if (!id && "email" in input) {
    // Nobody signed up with it: an invite, with a demo link that goes nowhere.
    const email = input.email.trim().toLowerCase();
    const open = (invitesByRepo.get(repoId) ?? []).filter((i) => i.email !== email);
    const invite: RepoInvite = {
      id: `inv_demo_${Date.now()}`,
      email,
      role: input.role,
      invitedBy: { principalId: ME, name: PEOPLE[ME]?.name ?? "You" },
      createdAt: iso(0),
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      expired: false,
    };
    invitesByRepo.set(repoId, [...open, invite]);
    return { invite, inviteUrl: `${window.location.origin}/invite/gtm_demo-link-not-real` };
  }
  if (!id) throw new ApiError(404, "not-found", "not a person");
  const existing = all.find((m) => m.principalId === id);
  if (existing) {
    const owners = all.filter((m) => m.role === "owner").length;
    if (existing.role === "owner" && input.role !== "owner" && owners === 1) throw lastOwner();
    existing.role = input.role;
    return { member: { ...existing } };
  }
  const added = member(id, input.role, 0);
  all.push(added);
  return { member: added };
}

export async function revokeInvite(
  repoId: string,
  inviteId: string,
): Promise<{ revoked: true; inviteId: string }> {
  await wait(300);
  invitesByRepo.set(
    repoId,
    (invitesByRepo.get(repoId) ?? []).filter((i) => i.id !== inviteId),
  );
  return { revoked: true, inviteId };
}

export async function removeMember(
  repoId: string,
  principalId: string,
): Promise<{ removed: true; principalId: string }> {
  await wait(420);
  const all = rows(repoId);
  const target = all.find((m) => m.principalId === principalId);
  if (!target) throw new ApiError(404, "not-found", "not a member");
  if (target.role === "owner" && all.filter((m) => m.role === "owner").length === 1)
    throw lastOwner();
  byRepo.set(
    repoId,
    all.filter((m) => m.principalId !== principalId),
  );
  return { removed: true, principalId };
}
