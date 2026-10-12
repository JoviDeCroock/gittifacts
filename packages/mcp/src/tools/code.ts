/**
 * A repo's code and history for agents, the same views people browse: `list_repo_files` (a
 * directory at a ref, with its README), `read_repo_file` (one file), `list_commits` (first-parent
 * history, each commit with the Change that landed it), `get_commit` (one commit with its patch)
 * and `get_commit_activity` (commits per day and the top authors). Read-only; a clone is still the
 * way to read a whole tree or very large files.
 */
import type {
  CodeFileResponse,
  CodeTree,
  CommitActivity,
  CommitDetail,
  CommitLog,
  CommitSummary,
} from "@app/domain";
import { defineTool } from "mcp-tada-server";
import { z } from "zod";
import type { McpBackend, McpCaller } from "../backend.js";
import type { ToolKit } from "./workspace.js";

// ---------------------------------------------------------------- backend contract

export interface CodeToolsBackend {
  listRepoFiles(
    caller: McpCaller,
    repoId: string,
    input: { ref?: string; path?: string },
  ): Promise<CodeTree>;
  readRepoFile(
    caller: McpCaller,
    repoId: string,
    input: { ref?: string; path: string },
  ): Promise<CodeFileResponse>;
  listCommits(
    caller: McpCaller,
    repoId: string,
    input: { ref?: string; limit?: number; offset?: number },
  ): Promise<CommitLog>;
  getCommit(caller: McpCaller, repoId: string, sha: string): Promise<CommitDetail>;
  getCommitActivity(
    caller: McpCaller,
    repoId: string,
    input: { ref?: string; weeks?: number },
  ): Promise<CommitActivity>;
}

// ---------------------------------------------------------------- schemas

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;
const int = { type: "integer" } as const;
const repoId = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  description: "The repo (list_repos).",
} as const;
const ref = {
  type: "string",
  minLength: 1,
  maxLength: 255,
  description: "Branch, tag or commit sha. Default: the repo's default branch (what has landed).",
} as const;
const path = {
  type: "string",
  maxLength: 1024,
  description: 'Repo-relative path, e.g. "src/lib" ("" or absent: the root).',
} as const;
const url = {
  type: "string",
  description: "The same view on the platform, to hand a person.",
} as const;

const Person = {
  type: "object",
  properties: {
    name: str,
    email: str,
    at: { ...nullableStr, description: "ISO time (null: unknown)." },
  },
  required: ["name", "email", "at"],
} as const;
const LandedBy = {
  type: ["object", "null"],
  description: "The Change whose merge produced this commit (null: pushed or imported directly).",
  properties: {
    changeId: str,
    title: str,
    lane: { type: ["integer", "null"] },
    authorKind: { enum: ["human", "agent", "system", "integration"] },
    authorName: str,
  },
  required: ["changeId", "title", "lane", "authorKind", "authorName"],
} as const;
const CommitBrief = {
  type: "object",
  properties: {
    sha: str,
    title: str,
    author: Person,
    committedAt: nullableStr,
    parents: { type: "array", items: str },
    landedBy: LandedBy,
    url,
  },
  required: ["sha", "title", "author", "committedAt", "parents", "landedBy", "url"],
} as const;

const ListFilesInput = {
  type: "object",
  properties: { repoId, path, ref },
  required: ["repoId"],
  additionalProperties: false,
} as const;
const ReadFileInput = {
  type: "object",
  properties: {
    repoId,
    path: { ...path, minLength: 1, description: 'The file, e.g. "src/index.ts".' },
    ref,
  },
  required: ["repoId", "path"],
  additionalProperties: false,
} as const;
const ListCommitsInput = {
  type: "object",
  properties: {
    repoId,
    ref,
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size (default 30)." },
    offset: { type: "integer", minimum: 0, description: "nextOffset from the previous page." },
  },
  required: ["repoId"],
  additionalProperties: false,
} as const;
const GetCommitInput = {
  type: "object",
  properties: {
    repoId,
    sha: {
      type: "string",
      pattern: "^[0-9a-f]{40}$",
      description: "Full commit sha (list_commits).",
    },
  },
  required: ["repoId", "sha"],
  additionalProperties: false,
} as const;
const ActivityInput = {
  type: "object",
  properties: {
    repoId,
    ref,
    weeks: {
      type: "integer",
      minimum: 1,
      maximum: 52,
      description: "Whole weeks back (default 26).",
    },
  },
  required: ["repoId"],
  additionalProperties: false,
} as const;

const ListFilesOutput = {
  type: "object",
  properties: {
    ref: str,
    commitSha: str,
    path: str,
    entries: {
      type: "array",
      description: "Directories first, then files, by name.",
      items: {
        type: "object",
        properties: {
          name: str,
          path: str,
          kind: { enum: ["dir", "file", "symlink", "submodule"] },
        },
        required: ["name", "path", "kind"],
      },
    },
    readme: {
      type: ["object", "null"],
      description: "The directory's README, when it has a text one.",
      properties: { path: str, text: str },
      required: ["path", "text"],
    },
    url,
  },
  required: ["ref", "commitSha", "path", "entries", "readme", "url"],
} as const;
const ReadFileOutput = {
  type: "object",
  properties: {
    ref: str,
    commitSha: str,
    path: str,
    size: int,
    kind: {
      enum: ["text", "binary", "too-large"],
      description: "too-large: over 512 KiB; clone to read it.",
    },
    text: { ...nullableStr, description: "The content (null unless kind is text)." },
    url,
  },
  required: ["ref", "commitSha", "path", "size", "kind", "text", "url"],
} as const;
const ListCommitsOutput = {
  type: "object",
  properties: {
    ref: str,
    headSha: { ...nullableStr, description: "Null: nothing has landed yet." },
    commits: { type: "array", items: CommitBrief, description: "Newest first (first-parent)." },
    nextOffset: {
      type: ["integer", "null"],
      description: "Pass as offset for the next page; null on the last.",
    },
  },
  required: ["ref", "headSha", "commits", "nextOffset"],
} as const;
const GetCommitOutput = {
  type: "object",
  properties: {
    commit: { ...CommitBrief, properties: { ...CommitBrief.properties, message: str } },
    parentSha: {
      ...nullableStr,
      description: "The diff's base (first parent); null for a root commit.",
    },
    additions: int,
    deletions: int,
    complete: {
      type: "boolean",
      description:
        "False: more files than a commit view reads; the rest are listed without a patch.",
    },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: str,
          previousPath: nullableStr,
          status: { enum: ["added", "modified", "deleted", "renamed", "copied", "type-changed"] },
          additions: int,
          deletions: int,
          binary: { type: "boolean" },
          patch: {
            ...nullableStr,
            description: "Unified hunks (null: binary, too large, or past the budget).",
          },
        },
        required: ["path", "previousPath", "status", "additions", "deletions", "binary", "patch"],
      },
    },
  },
  required: ["commit", "parentSha", "additions", "deletions", "complete", "files"],
} as const;
const ActivityOutput = {
  type: "object",
  properties: {
    ref: str,
    headSha: nullableStr,
    from: { ...str, description: "First day (a Monday, UTC)." },
    to: { ...str, description: "Today (UTC)." },
    total: int,
    days: {
      type: "array",
      description: "Commits per UTC day by landing (committer) date, from..to.",
      items: {
        type: "object",
        properties: { date: str, commits: int },
        required: ["date", "commits"],
      },
    },
    authors: {
      type: "array",
      items: {
        type: "object",
        properties: { name: str, commits: int },
        required: ["name", "commits"],
      },
    },
    truncated: {
      type: "boolean",
      description: "True: only the newest 1000 commits were read; counts are a lower bound.",
    },
    url,
  },
  required: ["ref", "headSha", "from", "to", "total", "days", "authors", "truncated", "url"],
} as const;

// ---------------------------------------------------------------- tools

const Id = z.string().min(1).max(64);
const Ref = z.string().min(1).max(255).optional();
const FilesArgs = z.object({ repoId: Id, path: z.string().max(1024).optional(), ref: Ref });
const FileArgs = z.object({ repoId: Id, path: z.string().min(1).max(1024), ref: Ref });
const CommitsArgs = z.object({
  repoId: Id,
  ref: Ref,
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});
const CommitArgs = z.object({ repoId: Id, sha: z.string().regex(/^[0-9a-f]{40}$/) });
const ActivityArgs = z.object({
  repoId: Id,
  ref: Ref,
  weeks: z.number().int().min(1).max(52).optional(),
});

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
/** Patch characters `get_commit` returns at most, over all files. */
export const PATCH_BUDGET = 200_000;

/** Drops undefined keys (the backend takes exact optional properties). */
function defined<T extends Record<string, unknown>>(
  o: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}

function patchOf(file: CommitDetail["diff"]["files"][number]): string | null {
  if (file.binary || file.hunks.length === 0) return null;
  const sign = { add: "+", del: "-", ctx: " " } as const;
  return file.hunks
    .map((h) => [h.header, ...h.lines.map((l) => `${sign[l.kind]}${l.text}`)].join("\n"))
    .join("\n");
}

export function codeTools(backend: McpBackend, kit: ToolKit) {
  const brief = (repo: string, c: CommitSummary) => ({
    sha: c.sha,
    title: c.title,
    author: c.author,
    committedAt: c.committer.at,
    parents: c.parents,
    landedBy: c.landedBy,
    url: backend.webUrl({ repoId: repo, commits: { sha: c.sha } }),
  });
  const reader = (ctx: Parameters<ToolKit["callerOf"]>[0]) => {
    const caller = kit.callerOf(ctx);
    kit.requireScope(caller, "repo:read");
    return caller;
  };
  return [
    defineTool({
      name: "list_repo_files",
      title: "List a repo's files",
      description:
        "A directory of a repo at a ref (default: its default branch, i.e. what has landed): entries, directories first, and the directory's README. Walk deeper with path; read a file with read_repo_file.",
      inputSchema: ListFilesInput,
      outputSchema: ListFilesOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = reader(ctx);
        const { repoId, ...input } = kit.parse(FilesArgs, args);
        const t = await kit.run(backend, () =>
          backend.listRepoFiles(caller, repoId, defined(input)),
        );
        return {
          ref: t.ref,
          commitSha: t.commitSha,
          path: t.path,
          entries: t.entries.map((e) => ({ name: e.name, path: e.path, kind: e.kind })),
          readme: t.readme?.text == null ? null : { path: t.readme.path, text: t.readme.text },
          url: backend.webUrl({ repoId, code: { kind: "tree", path: t.path, ref: input.ref } }),
        };
      },
    }),
    defineTool({
      name: "read_repo_file",
      title: "Read a file",
      description:
        "One file of a repo at a ref (default: its default branch): its text up to 512 KiB, or kind binary / too-large without content.",
      inputSchema: ReadFileInput,
      outputSchema: ReadFileOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = reader(ctx);
        const { repoId, ...input } = kit.parse(FileArgs, args);
        const r = await kit.run(backend, () =>
          backend.readRepoFile(caller, repoId, defined(input) as { path: string }),
        );
        return {
          ref: r.ref,
          commitSha: r.commitSha,
          path: r.file.path,
          size: r.file.size,
          kind: r.file.kind,
          text: r.file.text,
          url: backend.webUrl({
            repoId,
            code: { kind: "blob", path: r.file.path, ref: input.ref },
          }),
        };
      },
    }),
    defineTool({
      name: "list_commits",
      title: "List commits",
      description:
        "A repo's history from a ref (default: its default branch), newest first, a page at a time: each commit's title, author, time, and the Change that landed it (landedBy).",
      inputSchema: ListCommitsInput,
      outputSchema: ListCommitsOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = reader(ctx);
        const { repoId, ...input } = kit.parse(CommitsArgs, args);
        const log = await kit.run(backend, () =>
          backend.listCommits(caller, repoId, defined(input)),
        );
        return {
          ref: log.ref,
          headSha: log.headSha,
          commits: log.commits.map((c) => brief(repoId, c)),
          nextOffset: log.nextOffset,
        };
      },
    }),
    defineTool({
      name: "get_commit",
      title: "Get a commit",
      description:
        "One commit: message, author, the Change that landed it, and its patch against the first parent (per file, within a 200k-character budget).",
      inputSchema: GetCommitInput,
      outputSchema: GetCommitOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = reader(ctx);
        const { repoId, sha } = kit.parse(CommitArgs, args);
        const d = await kit.run(backend, () => backend.getCommit(caller, repoId, sha));
        let budget = PATCH_BUDGET;
        return {
          commit: { ...brief(repoId, d.commit), message: d.commit.message },
          parentSha: d.diff.parentSha,
          additions: d.diff.additions,
          deletions: d.diff.deletions,
          complete: d.diff.complete,
          files: d.diff.files.map((f) => {
            const patch = patchOf(f);
            const fits = patch !== null && patch.length <= budget;
            if (fits) budget -= patch.length;
            return {
              path: f.path,
              previousPath: f.previousPath,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              binary: f.binary,
              patch: fits ? patch : null,
            };
          }),
        };
      },
    }),
    defineTool({
      name: "get_commit_activity",
      title: "Get commit activity",
      description:
        "How active a repo is: commits per UTC day (by when they landed) over whole weeks, the total, and the top authors.",
      inputSchema: ActivityInput,
      outputSchema: ActivityOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = reader(ctx);
        const { repoId, ...input } = kit.parse(ActivityArgs, args);
        const a = await kit.run(backend, () =>
          backend.getCommitActivity(caller, repoId, defined(input)),
        );
        return {
          ref: a.ref,
          headSha: a.headSha,
          from: a.from,
          to: a.to,
          total: a.total,
          days: a.days,
          authors: a.authors,
          truncated: a.truncated,
          url: backend.webUrl({ repoId, activity: { ref: input.ref } }),
        };
      },
    }),
  ];
}
