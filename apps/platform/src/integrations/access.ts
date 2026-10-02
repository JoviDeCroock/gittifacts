/**
 * Who may install an integration on which repo, and which repos an installation reaches, on top of
 * the repo-access chokepoint (src/access/: memberships, effectiveRole, canAccess):
 *
 * - installing: only on **claimed** repos where the human is an **owner or maintainer**. Unclaimed
 *   projects can never be connected (nobody is a member of one, and they are refused by name).
 * - an installation reaches its selected repos, or (`all`) every repo the account owns or
 *   maintains, now and later, resolved at request time; a repo drops out as soon as it stops
 *   qualifying (the installer left it, it was deleted). The chokepoint then gives the integration
 *   principal `reader` on exactly those repos while the installer is still a member.
 */
import type { Principal, Repo } from "@app/domain";
import { eq } from "drizzle-orm";
import { canAccess } from "../access/access.js";
import { memberRole, membershipsOf } from "../access/members-store.js";
import type { RepoRole } from "../access/roles.js";
import type { Services } from "../app-env.js";
import { installationRepos, type installations } from "../db/schema.js";
import type { D1Store } from "../store/d1-store.js";

type InstallationRow = typeof installations.$inferSelect;

const INSTALLER_ROLES: readonly RepoRole[] = ["owner", "maintainer"];

/** May `human` connect integrations to `repo`? */
export async function canInstallOn(
  store: D1Store,
  human: Pick<Principal, "id" | "kind">,
  repo: Repo,
): Promise<boolean> {
  if (human.kind !== "human" || repo.claim.status !== "claimed") return false;
  const role = await memberRole(store, repo.id, human.id);
  return role !== null && INSTALLER_ROLES.includes(role);
}

/** Repos `human` may install integrations on (the install screen's repo picker). */
export async function installableRepos(
  svc: Pick<Services, "store">,
  human: Pick<Principal, "id" | "kind">,
): Promise<Repo[]> {
  if (human.kind !== "human") return [];
  const out: Repo[] = [];
  for (const [repoId, role] of await membershipsOf(svc.store, human.id)) {
    if (!INSTALLER_ROLES.includes(role)) continue;
    const repo = await svc.store.getRepo(repoId);
    if (repo && repo.claim.status === "claimed") out.push(repo);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Does an active installation cover `repo` right now? (Webhooks fan out only to these.) */
export async function installationCovers(
  store: D1Store,
  inst: Pick<InstallationRow, "id" | "accountId" | "repoSelection" | "status">,
  repo: Repo,
): Promise<boolean> {
  if (inst.status !== "active" || repo.claim.status !== "claimed") return false;
  const role = await memberRole(store, repo.id, inst.accountId);
  if (role === null) return false;
  if (inst.repoSelection === "all") return INSTALLER_ROLES.includes(role);
  const row = await store.db
    .select({ repoId: installationRepos.repoId })
    .from(installationRepos)
    .where(eq(installationRepos.installationId, inst.id))
    .all();
  return row.some((r) => r.repoId === repo.id);
}

/** The repo ids an installation reaches right now (its principal's grant; never unclaimed). */
export async function installationRepoIds(
  svc: Pick<Services, "store">,
  inst: Pick<InstallationRow, "id" | "accountId" | "repoSelection" | "status">,
): Promise<string[]> {
  if (inst.status !== "active") return [];
  const memberships = await membershipsOf(svc.store, inst.accountId);
  let candidates: string[];
  if (inst.repoSelection === "all") {
    candidates = [...memberships]
      .filter(([, role]) => INSTALLER_ROLES.includes(role))
      .map(([id]) => id);
  } else {
    const rows = await svc.store.db
      .select({ repoId: installationRepos.repoId })
      .from(installationRepos)
      .where(eq(installationRepos.installationId, inst.id))
      .all();
    candidates = rows.map((r) => r.repoId).filter((id) => memberships.has(id));
  }
  const out: string[] = [];
  for (const id of candidates) {
    const repo = await svc.store.getRepo(id);
    if (repo && repo.claim.status === "claimed") out.push(id);
  }
  return out;
}

/** An integration (or agent) may read `repo` through the chokepoint. */
export async function mayRead(svc: Services, p: Principal, repo: Repo): Promise<boolean> {
  return canAccess(svc, p, repo, "read");
}
