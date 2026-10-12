import {
  CodeFileResponse,
  CodeTree,
  CommitActivity,
  CommitDetail,
  CommitLog,
  MAX_ACTIVITY_WEEKS,
  MAX_LOG_PAGE,
} from "@app/domain";
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { RepoIdParam } from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import {
  getCommit,
  getCommitActivity,
  listCommits,
  listRepoFiles,
  rawRepoFile,
  readRepoFile,
} from "../services/code.js";
import { type ApiApp, errors, json, SECURITY } from "./common.js";

const RefQuery = z
  .string()
  .max(255)
  .optional()
  .describe("Branch, tag or commit sha (default: the repo's default branch)");
const PathQuery = z.object({
  ref: RefQuery,
  path: z.string().max(1024).optional().describe('Repo-relative path ("" or absent: the root)'),
});
const intQuery = (max: number) => z.coerce.number().int().min(0).max(max).optional();

const tree = createRoute({
  method: "get",
  path: "/api/v1/repos/{repoId}/tree",
  tags: ["code"],
  summary: "A directory's entries at a ref (directories first), with its README",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: RepoIdParam, query: PathQuery },
  responses: { 200: json(CodeTree, "Directory"), ...errors(400, 401, 403, 404) },
});

const file = createRoute({
  method: "get",
  path: "/api/v1/repos/{repoId}/file",
  tags: ["code"],
  summary: "One file at a ref: text up to 512 KiB, else binary or too-large without content",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: RepoIdParam, query: PathQuery },
  responses: { 200: json(CodeFileResponse, "File"), ...errors(400, 401, 403, 404) },
});

const commits = createRoute({
  method: "get",
  path: "/api/v1/repos/{repoId}/commits",
  tags: ["code"],
  summary: "First-parent history from a ref, newest first, each with the Change that landed it",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: {
    params: RepoIdParam,
    query: z.object({
      ref: RefQuery,
      limit: intQuery(MAX_LOG_PAGE).describe(`Page size, 1-${MAX_LOG_PAGE} (default 30)`),
      offset: intQuery(1_000_000).describe("nextOffset of the previous page"),
    }),
  },
  responses: { 200: json(CommitLog, "Commits"), ...errors(400, 401, 403, 404) },
});

const commit = createRoute({
  method: "get",
  path: "/api/v1/repos/{repoId}/commits/{sha}",
  tags: ["code"],
  summary: "One commit with its diff against its first parent",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: { params: RepoIdParam.extend({ sha: z.string().max(64) }) },
  responses: { 200: json(CommitDetail, "Commit"), ...errors(400, 401, 403, 404) },
});

const activity = createRoute({
  method: "get",
  path: "/api/v1/repos/{repoId}/activity",
  tags: ["code"],
  summary: "Commits per day (UTC, by landing date) over whole weeks, and the top authors",
  security: SECURITY,
  middleware: [requirePrincipal(["repo:read"])] as const,
  request: {
    params: RepoIdParam,
    query: z.object({
      ref: RefQuery,
      weeks: intQuery(MAX_ACTIVITY_WEEKS).describe(`1-${MAX_ACTIVITY_WEEKS} (default 26)`),
    }),
  },
  responses: { 200: json(CommitActivity, "Activity"), ...errors(400, 401, 403, 404) },
});

export function registerCodeRoutes(app: ApiApp): void {
  app.openapi(tree, async (c) =>
    c.json(
      await listRepoFiles(
        c.get("services"),
        callerOf(c),
        c.req.valid("param").repoId,
        c.req.valid("query"),
      ),
      200,
    ),
  );
  app.openapi(file, async (c) =>
    c.json(
      await readRepoFile(
        c.get("services"),
        callerOf(c),
        c.req.valid("param").repoId,
        c.req.valid("query"),
      ),
      200,
    ),
  );
  app.openapi(commits, async (c) =>
    c.json(
      await listCommits(
        c.get("services"),
        callerOf(c),
        c.req.valid("param").repoId,
        c.req.valid("query"),
      ),
      200,
    ),
  );
  app.openapi(commit, async (c) => {
    const { repoId, sha } = c.req.valid("param");
    return c.json(await getCommit(c.get("services"), callerOf(c), repoId, sha), 200);
  });
  app.openapi(activity, async (c) =>
    c.json(
      await getCommitActivity(
        c.get("services"),
        callerOf(c),
        c.req.valid("param").repoId,
        c.req.valid("query"),
      ),
      200,
    ),
  );

  // Raw bytes, served inert (see rawRepoFile): images, text, or a download.
  app.get("/api/v1/repos/:repoId/raw", requirePrincipal(["repo:read"]), (c) =>
    rawRepoFile(c.get("services"), callerOf(c), c.req.param("repoId"), {
      ...(c.req.query("ref") === undefined ? {} : { ref: c.req.query("ref") }),
      ...(c.req.query("path") === undefined ? {} : { path: c.req.query("path") }),
    }),
  );
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/api/v1/repos/{repoId}/raw",
    tags: ["code"],
    summary:
      "One file's raw bytes at a ref (images inline, text as text/plain, else a download; ≤10 MiB)",
    security: SECURITY,
    request: { params: RepoIdParam, query: PathQuery },
    responses: {
      200: { description: "The file's bytes" },
      ...errors(400, 401, 403, 404, 413),
    },
  });
}
