/**
 * Browsing a repo's code and history, read-only: the tree at a ref, one file (JSON or raw), the
 * commit log, one commit with its diff, and commit activity. Everything reads the repo's own
 * Artifacts repo (`artifactsName`: the default branch only the merge queue writes; in GitHub mode
 * the mirror) through the GitHost port, after the caller's read access is checked.
 */
import {
  type GitCommitInfo,
  type GitHost,
  type GitTreeItem,
  resolveRuntime,
} from "@app/coordinator";
import {
  type CodeEntryKind,
  type CodeFile,
  type CodeFileResponse,
  CodeRef,
  type CodeTree,
  type CommitActivity,
  type CommitDetail,
  type CommitLog,
  type CommitPerson,
  type CommitSummary,
  classifyFile,
  commitActivity,
  commitTitle,
  type LandedBy,
  MAX_ACTIVITY_COMMITS,
  MAX_ACTIVITY_WEEKS,
  MAX_INLINE_FILE_BYTES,
  MAX_LOG_PAGE,
  normalizeRepoPath,
  type Repo,
  readmeOf,
  sortTreeEntries,
} from "@app/domain";
import { assertRepoAccess } from "../access/access.js";
import type { Caller, Services } from "../app-env.js";
import { ApiError, badRequest, notFound } from "../errors.js";

/** A README larger than this is not inlined under its directory. */
const MAX_README_BYTES = 128 * 1024;

export interface CodeTarget {
  repo: Repo;
  git: GitHost;
  ref: string;
  sha: string;
}

export function gitOf(svc: Services): GitHost {
  return resolveRuntime(svc.env, "default").ports.git;
}

/** Checks read access, validates `ref` (default branch when absent) and resolves it to a commit. */
export async function codeTarget(
  svc: Services,
  caller: Caller,
  repoId: string,
  rawRef: string | undefined,
): Promise<CodeTarget> {
  const repo = await assertRepoAccess(svc, caller.principal, repoId, "read");
  const ref = rawRef === undefined || rawRef === "" ? repo.defaultBranch : rawRef;
  if (!CodeRef.safeParse(ref).success)
    throw badRequest(`ref ${JSON.stringify(ref)} is not a branch, tag or commit sha`);
  const git = gitOf(svc);
  const sha = await git.resolveRef(repo.artifactsName, ref);
  if (sha === null) {
    if (ref === repo.defaultBranch) throw emptyRepo(repo);
    throw notFound(`ref ${ref}`, {
      explanation: `${repo.name} has no branch, tag or commit named ${ref}. Leave ref out to read ${repo.defaultBranch}.`,
      call: `list_repo_files({ repoId: "${repo.id}" })`,
    });
  }
  return { repo, git, ref, sha };
}

function emptyRepo(repo: Repo): ApiError {
  return new ApiError(
    404,
    "empty-repo",
    `${repo.name} has no commits on ${repo.defaultBranch} yet`,
    undefined,
    {
      explanation: `Nothing has landed on ${repo.defaultBranch} yet. Clone the repo, commit and push (or start a Change); the code shows here once it lands.`,
      command: `gittifacts clone ${repo.id}`,
    },
  );
}

export function pathOf(raw: string | undefined): string {
  const path = normalizeRepoPath(raw ?? "");
  if (path === null)
    throw badRequest("path must be repo-relative, without `.`, `..` or empty segments");
  return path;
}

export function kindOf(item: Pick<GitTreeItem, "type" | "mode">): CodeEntryKind {
  if (item.type === "tree") return "dir";
  if (item.type === "gitlink" || item.mode === "160000") return "submodule";
  if (item.type === "symlink" || item.mode === "120000") return "symlink";
  return "file";
}

function noPath(t: CodeTarget, path: string) {
  return notFound(`${path} at ${t.ref}`, {
    explanation: `Nothing is at ${path} on ${t.ref}. List the directory above it to see what is there.`,
    call: `list_repo_files({ repoId: "${t.repo.id}", path: "${path.split("/").slice(0, -1).join("/")}" })`,
  });
}

export async function listRepoFiles(
  svc: Services,
  caller: Caller,
  repoId: string,
  input: { ref?: string; path?: string },
): Promise<CodeTree> {
  const path = pathOf(input.path);
  const t = await codeTarget(svc, caller, repoId, input.ref);
  const at = await t.git.readPath(t.repo.artifactsName, t.sha, path, { maxBytes: 0 });
  if (at === null) throw noPath(t, path);
  if (at.type !== "tree") {
    throw new ApiError(400, "not-a-directory", `${path} is a file`, undefined, {
      explanation: `${path} is a file, not a directory. Read it instead.`,
      call: `read_repo_file({ repoId: "${repoId}", path: "${path}" })`,
    });
  }
  const join = (name: string) => (path === "" ? name : `${path}/${name}`);
  const entries = sortTreeEntries(
    at.entries.map((e) => ({
      name: e.name,
      path: join(e.name),
      kind: kindOf(e),
      mode: e.mode,
      sha: e.sha,
    })),
  );
  const readmeEntry = readmeOf(entries);
  let readme: CodeFile | null = null;
  if (readmeEntry !== null) {
    const blob = await t.git.readPath(t.repo.artifactsName, t.sha, readmeEntry.path, {
      maxBytes: MAX_README_BYTES,
    });
    if (blob?.type === "blob" && blob.bytes !== null) {
      const { kind, text } = classifyFile(blob.bytes);
      if (kind === "text")
        readme = { path: readmeEntry.path, sha: blob.sha, size: blob.size, kind, text };
    }
  }
  return { ref: t.ref, commitSha: t.sha, path, entries, readme };
}

export async function readRepoFile(
  svc: Services,
  caller: Caller,
  repoId: string,
  input: { ref?: string; path?: string },
): Promise<CodeFileResponse> {
  const path = pathOf(input.path);
  if (path === "") throw badRequest("path names a file; the root is a directory (list_repo_files)");
  const t = await codeTarget(svc, caller, repoId, input.ref);
  const at = await t.git.readPath(t.repo.artifactsName, t.sha, path, {
    maxBytes: MAX_INLINE_FILE_BYTES,
  });
  if (at === null) throw noPath(t, path);
  if (at.type !== "blob" || at.mode === "160000") {
    throw new ApiError(
      400,
      "not-a-file",
      `${path} is a ${at.type === "tree" ? "directory" : "submodule"}`,
      undefined,
      {
        explanation: `${path} is not a file. List it instead.`,
        call: `list_repo_files({ repoId: "${repoId}", path: "${path}" })`,
      },
    );
  }
  const { kind, text } =
    at.bytes === null ? { kind: "too-large" as const, text: null } : classifyFile(at.bytes);
  return { ref: t.ref, commitSha: t.sha, file: { path, sha: at.sha, size: at.size, kind, text } };
}

// ---------------------------------------------------------------- raw

/** Raw bytes served at most; larger files are for a clone. */
const MAX_RAW_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
};

/**
 * The file's bytes, served inert like `/api/v1/blobs` (repo-controlled content): images by an
 * allowlist, text as text/plain (never HTML or SVG as such), everything else as a download.
 */
export async function rawRepoFile(
  svc: Services,
  caller: Caller,
  repoId: string,
  input: { ref?: string; path?: string },
): Promise<Response> {
  const path = pathOf(input.path);
  const t = await codeTarget(svc, caller, repoId, input.ref);
  const at = await t.git.readPath(t.repo.artifactsName, t.sha, path, { maxBytes: MAX_RAW_BYTES });
  if (at === null || at.type !== "blob" || at.mode === "160000") throw noPath(t, path);
  if (at.bytes === null) {
    throw new ApiError(413, "too-large", `${path} is ${at.size} bytes`, undefined, {
      explanation: `Files over ${MAX_RAW_BYTES / 1024 / 1024} MiB are not served raw. Clone the repo to read it.`,
      command: `gittifacts clone ${t.repo.id}`,
    });
  }
  const name = path.split("/").pop() ?? "file";
  const image = IMAGE_TYPES[name.split(".").pop()?.toLowerCase() ?? ""];
  const kind = image ? "image" : classifyFile(at.bytes.subarray(0, MAX_INLINE_FILE_BYTES)).kind;
  const type =
    image ?? (kind === "text" ? "text/plain; charset=utf-8" : "application/octet-stream");
  const inline = image !== undefined || kind === "text";
  return new Response(at.bytes, {
    status: 200,
    headers: {
      "content-type": type,
      "content-length": String(at.bytes.length),
      etag: `"${at.sha}"`,
      "cache-control": "private, max-age=60",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/["\\\r\n]/g, "")}"`,
    },
  });
}

// ---------------------------------------------------------------- history

export const DEFAULT_LOG_PAGE = 30;
/** Files a commit view reads and diffs at most; the rest are listed by path. */
export const MAX_COMMIT_FILES = 300;

function person(p: GitCommitInfo["author"]): CommitPerson {
  return {
    name: p.name,
    email: p.email,
    at: p.at > 0 ? new Date(p.at * 1000).toISOString() : null,
  };
}

export function commitSummary(c: GitCommitInfo, landedBy: LandedBy | null): CommitSummary {
  return {
    sha: c.sha,
    title: commitTitle(c.message),
    message: c.message.slice(0, 20_000),
    author: person(c.author),
    committer: person(c.committer),
    parents: c.parents,
    landedBy,
  };
}

/** `codeTarget`, except an empty repo is an empty history rather than an error. */
export async function historyTarget(
  svc: Services,
  caller: Caller,
  repoId: string,
  ref: string | undefined,
): Promise<CodeTarget | { empty: string }> {
  try {
    return await codeTarget(svc, caller, repoId, ref);
  } catch (e) {
    if (e instanceof ApiError && e.code === "empty-repo") {
      const repo = await svc.store.getRepo(repoId);
      return { empty: ref || repo?.defaultBranch || "main" };
    }
    throw e;
  }
}

export async function listCommits(
  svc: Services,
  caller: Caller,
  repoId: string,
  input: { ref?: string; limit?: number; offset?: number },
): Promise<CommitLog> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LOG_PAGE, 1), MAX_LOG_PAGE);
  const offset = Math.max(input.offset ?? 0, 0);
  const t = await historyTarget(svc, caller, repoId, input.ref);
  if ("empty" in t) return { ref: t.empty, headSha: null, commits: [], nextOffset: null };
  // One extra row says whether another page exists. The resolved sha keeps pages consistent.
  const rows = await t.git.log(t.repo.artifactsName, t.sha, { limit: limit + 1, offset });
  const page = rows.slice(0, limit);
  const landed = await svc.store.changesLandedAt(
    t.repo.id,
    page.map((c) => c.sha),
  );
  return {
    ref: t.ref,
    headSha: t.sha,
    commits: page.map((c) => commitSummary(c, landed.get(c.sha) ?? null)),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

export async function getCommit(
  svc: Services,
  caller: Caller,
  repoId: string,
  sha: string,
): Promise<CommitDetail> {
  const repo = await assertRepoAccess(svc, caller.principal, repoId, "read");
  if (!/^[0-9a-f]{40}$/.test(sha)) throw badRequest("sha must be a full 40-character commit sha");
  const git = gitOf(svc);
  const c = await git.readCommit(repo.artifactsName, sha);
  if (c === null) {
    throw notFound(`commit ${sha}`, {
      explanation: `${repo.name} has no commit ${sha}. List its history for the shas it has.`,
      call: `list_commits({ repoId: "${repo.id}" })`,
    });
  }
  const parentSha = c.parents[0] ?? null;
  const [diff, landed] = await Promise.all([
    git.diff(repo.artifactsName, parentSha, sha, {
      maxFileBytes: 256 * 1024,
      maxFiles: MAX_COMMIT_FILES,
    }),
    svc.store.changesLandedAt(repo.id, [sha]),
  ]);
  return {
    commit: commitSummary(c, landed.get(sha) ?? null),
    diff: {
      parentSha,
      files: diff.files,
      additions: diff.additions,
      deletions: diff.deletions,
      complete: diff.files.length <= MAX_COMMIT_FILES,
    },
  };
}

export const DEFAULT_ACTIVITY_WEEKS = 26;

export async function getCommitActivity(
  svc: Services,
  caller: Caller,
  repoId: string,
  input: { ref?: string; weeks?: number },
): Promise<CommitActivity> {
  const weeks = Math.min(Math.max(input.weeks ?? DEFAULT_ACTIVITY_WEEKS, 1), MAX_ACTIVITY_WEEKS);
  const t = await historyTarget(svc, caller, repoId, input.ref);
  const nowMs = svc.clock.now().getTime();
  if ("empty" in t) {
    return { ref: t.empty, headSha: null, ...commitActivity([], { nowMs, weeks, capped: false }) };
  }
  const rows = await t.git.log(t.repo.artifactsName, t.sha, { limit: MAX_ACTIVITY_COMMITS });
  const commits = rows.map((c) => ({
    at: c.committer.at > 0 ? c.committer.at : null,
    author: c.author.name,
  }));
  return {
    ref: t.ref,
    headSha: t.sha,
    ...commitActivity(commits, { nowMs, weeks, capped: rows.length >= MAX_ACTIVITY_COMMITS }),
  };
}
