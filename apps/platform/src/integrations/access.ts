/**
 * Who may install an integration on which repo, and which repos an installation reaches.
 * Every check lives here so the coming repo-membership chokepoint (`src/access/`: effectiveRole,
 * assertRepoAccess, accessibleRepoIds) is a one-line swap:
 *
 * - installing: only on **claimed** repos where the human is the owner (later: owner or
 *   maintainer). Unclaimed projects can never be connected (no production deploys from them).
 * - an installation reaches its selected repos, or (`all`) every repo the account may install on,
 *   resolved at request time; repos that stop qualifying (unclaimed, deleted, lost the role) drop
 *   out at once.
 */
import type { Principal, Repo } from "@app/domain";
import { eq } from "drizzle-orm";
import type { Services } from "../app-env.js";
import { installationRepos, type installations } from "../db/schema.js";

type InstallationRow = typeof installations.$inferSelect;

/** May `human` connect integrations to `repo`? (Swap for effectiveRole ∈ {owner, maintainer}.) */
export function canInstallOn(human: Pick<Principal, "id" | "kind">, repo: Repo): boolean {
  return (
    human.kind === "human" && repo.claim.status === "claimed" && repo.claim.ownerId === human.id
  );
}

/** Repos `human` may install integrations on (the install screen's repo picker). */
export async function installableRepos(
  svc: Services,
  human: Pick<Principal, "id" | "kind">,
): Promise<Repo[]> {
  if (human.kind !== "human") return [];
  return (await svc.store.listRepos()).filter((r) => canInstallOn(human, r));
}

/** The repo ids an installation reaches right now (never an unclaimed repo). */
export async function installationRepoIds(
  svc: Services,
  inst: Pick<InstallationRow, "id" | "accountId" | "repoSelection" | "status">,
): Promise<string[]> {
  if (inst.status !== "active") return [];
  const account = { id: inst.accountId, kind: "human" as const };
  const eligible = new Map((await installableRepos(svc, account)).map((r) => [r.id, r]));
  if (inst.repoSelection === "all") return [...eligible.keys()];
  const rows = await svc.store.db
    .select({ repoId: installationRepos.repoId })
    .from(installationRepos)
    .where(eq(installationRepos.installationId, inst.id))
    .all();
  return rows.map((r) => r.repoId).filter((id) => eligible.has(id));
}

/** An integration principal may touch `repoId` (claimed, in its current grant). */
export function integrationRepoAllowed(p: Principal, repoId: string): boolean {
  return p.kind === "integration" && (p.repoIds ?? []).includes(repoId);
}
