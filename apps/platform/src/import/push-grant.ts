/**
 * Import by push (DECISIONS 2026-10-02 "Import by push"): how a private repo gets onto the
 * platform. Artifacts `import` only reads public https remotes, so a human owner creates an empty
 * project and pushes its history with a one-time grant.
 *
 * - `openImportGrant`: a human with admin (owner) on a repo whose default branch does not exist
 *   gets an Artifacts write token for the MAIN repo (TTL <= 30 min). It is returned once; only
 *   its id is stored. Audited `project.import-push-opened`.
 * - It closes at the first of: any push to the repo (PushRouter observer, `onImportPush`), the
 *   first Change on the repo (`closeImportGrantBeforeChange`, in the facade's startChange and
 *   startBootstrapChange), the TTL (cron `sweepImportGrants`), or the owner closing it. Closing
 *   revokes the token. A revocation Artifacts can't confirm leaves the grant `closing`:
 *   start_change refuses (503) until it is confirmed or the token has expired; the cron retries.
 * - Closed with the default branch present = imported: `onImported` starts the bootstrap CI and
 *   the O5 detection proposal (`.platform/*` as a Plan + Lane 2 Change a human approves).
 *
 * The one exception to "only the merge queue writes main": an empty repo's initial import, by
 * its human owner, before any Change exists, audited when opened and closed.
 */

import type { Audit, GitHost } from "@app/coordinator";
import { SYSTEM_PRINCIPAL_ID } from "@app/coordinator";
import type { Principal, Repo } from "@app/domain";
import { ApiError } from "../errors.js";
import type { D1Store, Db } from "../store/d1-store.js";
import {
  getGrant,
  grantsToSweep,
  type ImportCloseReason,
  type ImportGrantRow,
  markClosed,
  markClosing,
  putOpenGrant,
} from "./grant-store.js";

export const IMPORT_GRANT_TTL_SECONDS = 1800;
const TOKEN_ENV = "GITTIFACTS_IMPORT_TOKEN";

export interface GrantDeps {
  db: Db;
  store: Pick<D1Store, "getRepo" | "getRepoByArtifactsName">;
  audit: Audit;
  git: Pick<GitHost, "mintImportToken" | "revokeToken" | "branchHead" | "remoteOf">;
  now(): Date;
  /** After a push import (bootstrap CI + the detection proposal). Failures are logged. */
  onImported?(repo: Repo, input: { mainSha: string; openedBy: string }): Promise<void>;
}

/** What `GET …/import-grant` shows: never the token. */
export interface ImportGrantView {
  repoId: string;
  status: "open" | "closing" | "closed";
  openedBy: string;
  openedAt: string;
  openUntil: string;
  closeReason: ImportCloseReason | null;
  closedAt: string | null;
  /** The default branch's head when the grant closed. */
  mainSha: string | null;
  /** Closed with the default branch present: the history is on the platform. */
  imported: boolean;
}

/** Returned once, to the human who opened it. */
export interface ImportGrant {
  url: string;
  branch: string;
  token: string;
  expiresAt: string;
  command: string;
  closesWhen: string;
}

export function grantView(row: ImportGrantRow): ImportGrantView {
  const { repoId, status, openedBy, openedAt, openUntil, closeReason, closedAt, mainSha } = row;
  const imported = status === "closed" && mainSha !== null;
  return {
    repoId,
    status,
    openedBy,
    openedAt,
    openUntil,
    closeReason,
    closedAt,
    mainSha,
    imported,
  };
}

export function humanRequired(): ApiError {
  return new ApiError(
    403,
    "human-required",
    "import by push needs a human owner: its grant is a write token for the project's main repo",
    { importMode: "push" },
    {
      explanation:
        'Agents never hold a token that writes a main repo. Ask your human to create the project signed in (POST /api/v1/projects { name, importMode: "push" } with their session) and push the history; then work on it through Plans and Changes as usual.',
    },
  );
}

function closingError(repoId: string): ApiError {
  return new ApiError(
    503,
    "import-grant-closing",
    `the import grant of ${repoId} is closing: its token's revocation is not confirmed yet`,
    { repoId },
    {
      explanation:
        "The platform revokes the owner's import token before the first Change. Retry the same call in a minute; the token expires within 30 minutes at the latest.",
    },
  );
}

/** Open (or re-open) the grant. The caller has checked `admin` on the repo. */
export async function openImportGrant(
  deps: GrantDeps,
  actor: Principal,
  repo: Repo,
): Promise<{ grant: ImportGrant; view: ImportGrantView }> {
  if (actor.kind !== "human") throw humanRequired();
  const previous = await getGrant(deps.db, repo.id);
  if (previous !== null && previous.status !== "closed") {
    // A fresh grant replaces the live one: its token is revoked first (never two live tokens).
    const closed = await closeImportGrant(deps, repo, actor.id, "closed-by-owner");
    if (closed?.status !== "closed") throw closingError(repo.id);
  }
  let minted: Awaited<ReturnType<GrantDeps["git"]["mintImportToken"]>>;
  try {
    minted = await deps.git.mintImportToken(repo.artifactsName, {
      branch: repo.defaultBranch,
      ttlSeconds: IMPORT_GRANT_TTL_SECONDS,
    });
  } catch (e) {
    if ((await deps.git.branchHead(repo.artifactsName, repo.defaultBranch)) === null) throw e;
    throw new ApiError(
      409,
      "already-imported",
      `${repo.name} already has ${repo.defaultBranch}: an import grant is only for an empty project`,
      { repoId: repo.id },
      {
        explanation:
          "Only the merge queue writes a project's default branch once it exists. Propose changes as Plans and Changes.",
        call: `start_change({ repoId: "${repo.id}", title: "<what>", category: "feature" })`,
      },
    );
  }
  const openedAt = deps.now().toISOString();
  const row = { repoId: repo.id, openedBy: actor.id, tokenId: minted.tokenId, openedAt };
  if (!(await putOpenGrant(deps.db, { ...row, openUntil: minted.expiresAt }))) {
    // Someone opened one concurrently: this token must not outlive the race.
    await deps.git.revokeToken(repo.artifactsName, minted.tokenId).catch(() => false);
    throw closingError(repo.id);
  }
  await deps.audit.append({
    principalId: actor.id,
    action: "project.import-push-opened",
    subject: `repo:${repo.id}`,
    payload: { tokenId: minted.tokenId, branch: repo.defaultBranch, openUntil: minted.expiresAt },
  });
  const url = deps.git.remoteOf(repo.artifactsName);
  const branch = repo.defaultBranch;
  return {
    grant: {
      url,
      branch,
      token: minted.token,
      expiresAt: minted.expiresAt,
      command: `git -c http.extraHeader="Authorization: Bearer $${TOKEN_ENV}" push ${url} <your-branch>:refs/heads/${branch} --follow-tags`,
      closesWhen: `Put the token in $${TOKEN_ENV} (never in the remote URL or git config) and push the whole history in ONE git push: the first push to this repo closes the grant, as do the first Change and ${IMPORT_GRANT_TTL_SECONDS / 60} minutes. The platform then proposes .platform/* as a Plan + Change for you to approve.`,
    },
    view: grantView({
      ...row,
      openUntil: minted.expiresAt,
      status: "open",
      closeReason: null,
      closedAt: null,
      mainSha: null,
    }),
  };
}

/**
 * Close the grant: revoke its token, then record the default branch's head. Returns the view
 * (`closing` while the revocation is unconfirmed and the token unexpired), or null without one.
 */
export async function closeImportGrant(
  deps: GrantDeps,
  repo: Repo,
  actorId: string,
  reason: ImportCloseReason,
): Promise<ImportGrantView | null> {
  let row = await getGrant(deps.db, repo.id);
  if (row === null || row.status === "closed") return row === null ? null : grantView(row);
  if (row.status === "open") await markClosing(deps.db, repo.id, reason);
  row = (await getGrant(deps.db, repo.id)) ?? row;
  if (row.status === "closed") return grantView(row);
  const revoked = await deps.git.revokeToken(repo.artifactsName, row.tokenId).catch((e) => {
    console.warn("import grant: revocation failed", repo.id, e);
    return false;
  });
  const expired = deps.now().getTime() >= Date.parse(row.openUntil);
  if (!revoked && !expired) return grantView(row);
  const mainSha = await deps.git.branchHead(repo.artifactsName, repo.defaultBranch);
  const closedAt = deps.now().toISOString();
  if (await markClosed(deps.db, repo.id, { closedAt, mainSha })) {
    await deps.audit.append({
      principalId: actorId,
      action: "project.import-push-closed",
      subject: `repo:${repo.id}`,
      payload: {
        reason: row.closeReason ?? reason,
        revoked,
        expired,
        mainSha,
        openedBy: row.openedBy,
      },
    });
    if (mainSha !== null && deps.onImported !== undefined) {
      await deps.onImported(repo, { mainSha, openedBy: row.openedBy }).catch((e: unknown) => {
        console.error("import grant: post-import steps failed", repo.id, e);
      });
    }
  }
  const after = await getGrant(deps.db, repo.id);
  return after === null ? null : grantView(after);
}

/**
 * PushRouter observer: the first push to a repo with a live grant closes it (any ref; the
 * default branch's head is read at close time). Throws while the revocation is unconfirmed, so
 * the observer step retries (then the cron).
 */
export async function onImportPush(
  deps: GrantDeps,
  push: { repoName: string; ref: string },
): Promise<ImportGrantView | null> {
  if (push.repoName.startsWith("task-")) return null; // change forks never have grants
  const repo = await deps.store.getRepoByArtifactsName(push.repoName);
  if (repo === null) return null;
  const row = await getGrant(deps.db, repo.id);
  if (row === null || row.status === "closed") return null;
  const view = await closeImportGrant(deps, repo, SYSTEM_PRINCIPAL_ID, "pushed");
  if (view !== null && view.status !== "closed") {
    throw new Error(`import grant of ${repo.id}: revocation not confirmed yet`);
  }
  return view;
}

/** Before any Change forks the repo: the grant must be closed (token revoked) first. */
export async function closeImportGrantBeforeChange(
  deps: GrantDeps,
  repoId: string,
  actorId: string,
): Promise<void> {
  const row = await getGrant(deps.db, repoId);
  if (row === null || row.status === "closed") return;
  const repo = await deps.store.getRepo(repoId);
  if (repo === null) return;
  const view = await closeImportGrant(deps, repo, actorId, "change-started");
  if (view !== null && view.status !== "closed") throw closingError(repoId);
}

/** Cron: close grants past their TTL and finish the ones whose revocation was unconfirmed. */
export async function sweepImportGrants(deps: GrantDeps): Promise<ImportGrantView[]> {
  const out: ImportGrantView[] = [];
  for (const row of await grantsToSweep(deps.db, deps.now().toISOString())) {
    const repo = await deps.store.getRepo(row.repoId);
    if (repo === null) continue;
    try {
      const view = await closeImportGrant(deps, repo, SYSTEM_PRINCIPAL_ID, "expired");
      if (view !== null) out.push(view);
    } catch (e) {
      console.warn("import grant sweep failed", row.repoId, e);
    }
  }
  return out;
}

/** The repo's grant, closing it first when its TTL has passed (reads stay truthful). */
export async function importGrantStatus(
  deps: GrantDeps,
  repo: Repo,
): Promise<ImportGrantView | null> {
  const row = await getGrant(deps.db, repo.id);
  if (row === null) return null;
  if (row.status !== "closed" && deps.now().getTime() >= Date.parse(row.openUntil)) {
    return closeImportGrant(deps, repo, SYSTEM_PRINCIPAL_ID, "expired");
  }
  return grantView(row);
}
