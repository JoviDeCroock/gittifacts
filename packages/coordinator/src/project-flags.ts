/**
 * One Flagship app per project (cross-tenant flag isolation). Every project with a deploy target
 * gets its own app, named `gf-<repoId>`; its deployed Workers bind `FLAGS` to that app only, and
 * its change flags are created and flipped there. Before this, every project shared one app, so
 * any project's Worker could read every other project's change flags.
 *
 * Created when a deploy target is set, and lazily before any flag or deploy needs it (repos from
 * before per-project apps). Flagship app names are not unique, so creation converges in two steps:
 * `Flags.ensureApp` reuses the oldest app with the name (a retried create finds its own first
 * attempt), and the Store's compare-and-set keeps the first id recorded for the repo; an app that
 * lost that race is deleted again.
 */
import type { Repo } from "@app/domain";
import type { Flags, Store } from "./ports.js";

/** The Flagship app name of a project (1–64 of `[A-Za-z0-9_-]`). */
export function projectFlagAppName(repoId: string): string {
  const slug = repoId.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 61);
  return `gf-${slug}`;
}

/** The project's Flagship app id, creating (and recording) the app when the repo has none yet. */
export async function ensureProjectFlagApp(
  ports: {
    store: Pick<Store, "getRepo" | "setRepoFlagshipApp">;
    flags: Pick<Flags, "ensureApp" | "deleteApp">;
  },
  repoOrId: Repo | string,
): Promise<string> {
  const repo = typeof repoOrId === "string" ? await ports.store.getRepo(repoOrId) : repoOrId;
  if (repo === null) throw new Error(`repo ${String(repoOrId)} not found`);
  if (repo.flagshipAppId) return repo.flagshipAppId;
  const created = await ports.flags.ensureApp(projectFlagAppName(repo.id));
  const stored = await ports.store.setRepoFlagshipApp(repo.id, created);
  if (stored !== created) {
    // A concurrent writer recorded another app first: ours must not linger (no Worker binds it).
    await ports.flags.deleteApp(created).catch(() => undefined);
  }
  return stored;
}
