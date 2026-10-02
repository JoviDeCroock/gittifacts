/**
 * Git URL naming: `https://<host>/git/<owner>/<repo>.git`.
 *
 * - `<repo>` is the repo's name, which is unique in the platform's Artifacts namespace.
 * - `<owner>` is the owning account's **handle**: assigned once on first use from the account's
 *   name (lower-case, [a-z0-9-], ≤ 30 chars, suffixed -2, -3… when taken) and then stable, so a
 *   URL a deploy platform stored keeps working when the person renames themselves.
 * - Change heads: `https://<host>/git/<owner>/<repo>/changes/<changeId>.git` (the Change's fork).
 *
 * Only claimed repos have an owner, so unclaimed projects have no git URL here at all.
 */
import type { Change, Repo } from "@app/domain";
import { and, eq } from "drizzle-orm";
import type { Services } from "../app-env.js";
import { accountHandles, principals, repos } from "../db/schema.js";

const MAX_HANDLE = 30;

export function slugify(raw: string): string {
  const local = raw.includes("@") ? (raw.split("@")[0] ?? raw) : raw;
  const s = local
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_HANDLE)
    .replace(/-+$/g, "");
  return s.length >= 2 ? s : "user";
}

/** What naming needs: the store, a clock and the platform origin (HTTP requests and background work). */
export type NamingDeps = Pick<Services, "store" | "clock" | "origin">;

/** The account's handle, assigned on first use. */
export async function handleFor(
  svc: Pick<Services, "store" | "clock">,
  principalId: string,
): Promise<string> {
  const db = svc.store.db;
  const existing = await db
    .select({ handle: accountHandles.handle })
    .from(accountHandles)
    .where(eq(accountHandles.principalId, principalId))
    .get();
  if (existing) return existing.handle;
  const p = await db
    .select({ name: principals.name })
    .from(principals)
    .where(eq(principals.id, principalId))
    .get();
  const base = slugify(p?.name ?? "user");
  for (let n = 1; n <= 20; n++) {
    const suffix = n === 1 ? "" : `-${n <= 10 ? n : crypto.randomUUID().slice(0, 6)}`;
    const candidate = `${base.slice(0, MAX_HANDLE - suffix.length)}${suffix}`;
    const inserted = await db
      .insert(accountHandles)
      .values({ principalId, handle: candidate, createdAt: svc.clock.now().toISOString() })
      .onConflictDoNothing()
      .returning({ handle: accountHandles.handle });
    if (inserted.length > 0) return candidate;
    // Either the handle is taken or a concurrent request assigned ours: re-read ours.
    const mine = await db
      .select({ handle: accountHandles.handle })
      .from(accountHandles)
      .where(eq(accountHandles.principalId, principalId))
      .get();
    if (mine) return mine.handle;
  }
  throw new Error(`could not assign a handle to ${principalId}`);
}

export interface RepoNames {
  owner: string;
  fullName: string;
  cloneUrl: string;
}

/** Owner handle, `owner/name` and clone URL of a claimed repo; null for an unclaimed one. */
export async function repoNames(svc: NamingDeps, repo: Repo): Promise<RepoNames | null> {
  if (repo.claim.status !== "claimed" || repo.claim.ownerId === null) return null;
  const owner = await handleFor(svc, repo.claim.ownerId);
  return {
    owner,
    fullName: `${owner}/${repo.name}`,
    cloneUrl: `${svc.origin}/git/${owner}/${repo.name}.git`,
  };
}

export function changeCloneUrl(names: RepoNames, change: Pick<Change, "id">): string {
  return names.cloneUrl.replace(/\.git$/, `/changes/${change.id}.git`);
}

/** `/git/<owner>/<repo>.git` → the repo, when `<owner>` is its owner's handle. */
export async function resolveRepoPath(
  svc: Pick<Services, "store">,
  owner: string,
  name: string,
): Promise<Repo | null> {
  const row = await svc.store.db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.name, name), eq(repos.claimStatus, "claimed")))
    .get();
  if (!row) return null;
  const repo = await svc.store.getRepo(row.id);
  if (!repo || repo.claim.ownerId === null) return null;
  const handle = await svc.store.db
    .select({ handle: accountHandles.handle })
    .from(accountHandles)
    .where(eq(accountHandles.principalId, repo.claim.ownerId))
    .get();
  if (!handle || handle.handle !== owner.toLowerCase()) return null;
  return repo;
}
