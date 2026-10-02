/**
 * Remote workspaces (onboarding §6): a sandbox with the Change's fork checked out, for agents
 * with no shell or git of their own. `open_workspace` starts (or resumes) it; `ws_exec`,
 * `ws_read`, `ws_write`, `ws_diff` and `ws_commit_push` work in it; `close_workspace` ends it.
 *
 * Declared here (one file per tool family) and added to `buildTools` in ../tools.ts. The shared
 * helpers (caller, scope check, parse, error envelope) come in as a `ToolKit` from tools.ts, so
 * there is one implementation of each and no import cycle.
 *
 * Only the Change's author may open its workspace (it pushes to the fork). Pushing goes to the
 * fork's branch and triggers the normal push flow: CI → evidence → lane → tour. Nothing here can
 * write the default branch: the workspace only ever holds a token for the Change's own fork.
 */
import type { ApiError, Scope } from "@app/domain";
import { defineTool, type ToolExtra } from "mcp-tada-server";
import { z } from "zod";
import type { McpBackend, McpCaller, MutationOptions } from "../backend.js";

// ---------------------------------------------------------------- backend contract

export type WorkspaceStatus = "starting" | "ready" | "sleeping" | "closed" | "expired";
export type WorkspaceNetwork = "open" | "registries-only";

export interface WorkspaceView {
  workspaceId: string;
  changeId: string;
  repoId: string;
  forkName: string;
  branch: string;
  baseSha: string;
  /** The commit the workspace's branch is at (checked out, or last pushed from here). */
  headSha: string | null;
  status: WorkspaceStatus;
  network: WorkspaceNetwork;
  /** Hard end of this workspace session (ISO). */
  expiresAt: string;
  /** Idle seconds before the workspace sleeps (snapshot + stop; the next call resumes it). */
  idleSleepSec: number;
  /** Where the container started from on its last (re)start. */
  restoredFrom: "sleep-snapshot" | "dependency-snapshot" | "image" | null;
  usage: {
    /** Container seconds used by this workspace. */
    containerSeconds: number;
    /** Container seconds left today for the project (null: unlimited). */
    projectSecondsRemaining: number | null;
  };
}

export interface WsExecResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  /** Output above the cap: the middle is dropped, the head and the tail are kept. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface WsReadResult {
  path: string;
  content: string;
  binary: boolean;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

export interface WsWriteResult {
  path: string;
  mode: "content" | "patch";
  bytes: number;
  created: boolean;
}

export interface WsDiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";
  additions: number;
  deletions: number;
}

export interface WsDiffResult {
  baseSha: string;
  files: WsDiffFile[];
  patch: string;
  truncated: boolean;
}

export interface WsCommitPushResult {
  changeId: string;
  branch: string;
  commitSha: string;
  previousHead: string | null;
  filesChanged: number;
  pushed: boolean;
}

export interface WorkspaceToolsBackend {
  /** Start or resume the Change's workspace (author only). Idempotent per Change. */
  openWorkspace(
    caller: McpCaller,
    input: { changeId: string },
    opts: MutationOptions,
  ): Promise<WorkspaceView>;
  closeWorkspace(
    caller: McpCaller,
    workspaceId: string,
    opts: MutationOptions,
  ): Promise<WorkspaceView>;
  wsExec(
    caller: McpCaller,
    input: { workspaceId: string; command: string; cwd?: string; timeoutSec?: number },
    opts: MutationOptions,
  ): Promise<WsExecResult>;
  wsRead(
    caller: McpCaller,
    input: { workspaceId: string; path: string; startLine?: number; endLine?: number },
  ): Promise<WsReadResult>;
  wsWrite(
    caller: McpCaller,
    input: { workspaceId: string; path: string; content?: string; patch?: string },
    opts: MutationOptions,
  ): Promise<WsWriteResult>;
  wsDiff(caller: McpCaller, workspaceId: string): Promise<WsDiffResult>;
  wsCommitPush(
    caller: McpCaller,
    input: { workspaceId: string; message: string },
    opts: MutationOptions,
  ): Promise<WsCommitPushResult>;
}

/** The helpers ../tools.ts shares with every tool family. */
export interface ToolKit {
  callerOf(ctx: ToolExtra): McpCaller;
  requireScope(caller: McpCaller, scope: Scope): void;
  parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S>;
  run<T>(backend: McpBackend, fn: () => Promise<T>): Promise<T>;
  failure(code: string, message: string, fix: ApiError["error"]["fix"], details?: unknown): Error;
}

// ---------------------------------------------------------------- limits (mirrored by the platform)

export const WS_LIMITS = {
  maxCommandChars: 16_384,
  maxPathChars: 1024,
  maxWriteBytes: 1_048_576,
  maxTimeoutSec: 1800,
  defaultTimeoutSec: 120,
  maxMessageChars: 10_000,
} as const;

// ---------------------------------------------------------------- JSON Schemas

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;
const int = { type: "integer" } as const;
const bool = { type: "boolean" } as const;

const idempotencyKey = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description:
    "Optional. Retrying with the same key returns the first result instead of acting twice.",
} as const;

const workspaceId = {
  type: "string",
  minLength: 4,
  maxLength: 100,
  pattern: "^ws-[A-Za-z0-9_-]+$",
  description: "From open_workspace.",
} as const;

const path = {
  type: "string",
  minLength: 1,
  maxLength: WS_LIMITS.maxPathChars,
  description: "Relative to the repository root (/workspace). Paths outside it are rejected.",
} as const;

const NextSteps = {
  type: "array",
  description: "What to do next, as concrete tool calls (call) or shell commands (command).",
  items: {
    type: "object",
    properties: { title: str, call: str, command: str, why: str },
    required: ["title"],
  },
} as const;

const WorkspaceViewSchema = {
  workspaceId: str,
  changeId: str,
  repoId: str,
  forkName: str,
  branch: str,
  baseSha: str,
  headSha: nullableStr,
  status: { enum: ["starting", "ready", "sleeping", "closed", "expired"] },
  network: { enum: ["open", "registries-only"] },
  expiresAt: str,
  idleSleepSec: int,
  restoredFrom: { enum: ["sleep-snapshot", "dependency-snapshot", "image", null] },
  usage: {
    type: "object",
    properties: {
      containerSeconds: { type: "number" },
      projectSecondsRemaining: { type: ["number", "null"] },
    },
    required: ["containerSeconds", "projectSecondsRemaining"],
  },
} as const;

const WORKSPACE_VIEW_REQUIRED = [
  "workspaceId",
  "changeId",
  "repoId",
  "forkName",
  "branch",
  "baseSha",
  "headSha",
  "status",
  "network",
  "expiresAt",
  "idleSleepSec",
  "restoredFrom",
  "usage",
] as const;

export const OpenWorkspaceInput = {
  type: "object",
  properties: {
    changeId: { type: "string", minLength: 1, maxLength: 64 },
    idempotencyKey,
  },
  required: ["changeId"],
  additionalProperties: false,
} as const;

export const OpenWorkspaceOutput = {
  type: "object",
  properties: {
    ...WorkspaceViewSchema,
    tools: {
      type: "array",
      description: "The workspace tools, each with a ready-to-use call.",
      items: {
        type: "object",
        properties: { name: str, call: str, description: str },
        required: ["name", "call", "description"],
      },
    },
    nextSteps: NextSteps,
  },
  required: [...WORKSPACE_VIEW_REQUIRED, "tools", "nextSteps"],
} as const;

export const WorkspaceIdInput = {
  type: "object",
  properties: { workspaceId, idempotencyKey },
  required: ["workspaceId"],
  additionalProperties: false,
} as const;

export const CloseWorkspaceOutput = {
  type: "object",
  properties: { ...WorkspaceViewSchema, nextSteps: NextSteps },
  required: [...WORKSPACE_VIEW_REQUIRED, "nextSteps"],
} as const;

export const WsExecInput = {
  type: "object",
  properties: {
    workspaceId,
    command: {
      type: "string",
      minLength: 1,
      maxLength: WS_LIMITS.maxCommandChars,
      description: "A shell command (sh -c), run as the unprivileged runner user.",
    },
    cwd: { ...path, description: "Working directory relative to the repository root." },
    timeoutSec: {
      type: "integer",
      minimum: 1,
      maximum: WS_LIMITS.maxTimeoutSec,
      description: `Default ${WS_LIMITS.defaultTimeoutSec}. Capped by the project's quota; keep it under your client's request timeout and background long jobs (nohup … &).`,
    },
    idempotencyKey,
  },
  required: ["workspaceId", "command"],
  additionalProperties: false,
} as const;

export const WsExecOutput = {
  type: "object",
  properties: {
    exitCode: { type: ["integer", "null"] },
    timedOut: bool,
    durationMs: int,
    stdout: str,
    stderr: str,
    stdoutBytes: int,
    stderrBytes: int,
    stdoutTruncated: bool,
    stderrTruncated: bool,
    nextSteps: NextSteps,
  },
  required: [
    "exitCode",
    "timedOut",
    "durationMs",
    "stdout",
    "stderr",
    "stdoutBytes",
    "stderrBytes",
    "stdoutTruncated",
    "stderrTruncated",
    "nextSteps",
  ],
} as const;

export const WsReadInput = {
  type: "object",
  properties: {
    workspaceId,
    path,
    startLine: { type: "integer", minimum: 1, description: "1-based, inclusive." },
    endLine: { type: "integer", minimum: 1, description: "1-based, inclusive." },
  },
  required: ["workspaceId", "path"],
  additionalProperties: false,
} as const;

export const WsReadOutput = {
  type: "object",
  properties: {
    path: str,
    content: str,
    binary: bool,
    sizeBytes: int,
    totalLines: int,
    startLine: int,
    endLine: int,
    truncated: bool,
  },
  required: [
    "path",
    "content",
    "binary",
    "sizeBytes",
    "totalLines",
    "startLine",
    "endLine",
    "truncated",
  ],
} as const;

export const WsWriteInput = {
  type: "object",
  properties: {
    workspaceId,
    path: { ...path, description: "The file to write (or the one file the patch changes)." },
    content: {
      type: "string",
      maxLength: WS_LIMITS.maxWriteBytes,
      description: "The whole new file content (creates parent directories). Pass this or patch.",
    },
    patch: {
      type: "string",
      maxLength: WS_LIMITS.maxWriteBytes,
      description: "A unified diff (git apply) that changes only `path`. Pass this or content.",
    },
    idempotencyKey,
  },
  required: ["workspaceId", "path"],
  additionalProperties: false,
} as const;

export const WsWriteOutput = {
  type: "object",
  properties: {
    path: str,
    mode: { enum: ["content", "patch"] },
    bytes: int,
    created: bool,
    nextSteps: NextSteps,
  },
  required: ["path", "mode", "bytes", "created", "nextSteps"],
} as const;

export const WsDiffInput = {
  type: "object",
  properties: { workspaceId },
  required: ["workspaceId"],
  additionalProperties: false,
} as const;

export const WsDiffOutput = {
  type: "object",
  properties: {
    baseSha: str,
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: str,
          status: {
            enum: ["added", "modified", "deleted", "renamed", "copied", "type-changed"],
          },
          additions: int,
          deletions: int,
        },
        required: ["path", "status", "additions", "deletions"],
      },
    },
    patch: str,
    truncated: bool,
    nextSteps: NextSteps,
  },
  required: ["baseSha", "files", "patch", "truncated", "nextSteps"],
} as const;

export const WsCommitPushInput = {
  type: "object",
  properties: {
    workspaceId,
    message: { type: "string", minLength: 1, maxLength: WS_LIMITS.maxMessageChars },
    idempotencyKey,
  },
  required: ["workspaceId", "message"],
  additionalProperties: false,
} as const;

export const WsCommitPushOutput = {
  type: "object",
  properties: {
    changeId: str,
    branch: str,
    commitSha: str,
    previousHead: nullableStr,
    filesChanged: int,
    pushed: bool,
    nextSteps: NextSteps,
  },
  required: [
    "changeId",
    "branch",
    "commitSha",
    "previousHead",
    "filesChanged",
    "pushed",
    "nextSteps",
  ],
} as const;

// ---------------------------------------------------------------- zod (defence in depth)

const WorkspaceIdArg = z
  .string()
  .regex(/^ws-[A-Za-z0-9_-]+$/)
  .max(100);
const PathArg = z.string().min(1).max(WS_LIMITS.maxPathChars);
const ExecArgs = z.object({
  workspaceId: WorkspaceIdArg,
  command: z.string().min(1).max(WS_LIMITS.maxCommandChars),
  cwd: PathArg.optional(),
  timeoutSec: z.number().int().min(1).max(WS_LIMITS.maxTimeoutSec).optional(),
});
const ReadArgs = z
  .object({
    workspaceId: WorkspaceIdArg,
    path: PathArg,
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  })
  .refine((v) => v.startLine === undefined || v.endLine === undefined || v.endLine >= v.startLine, {
    message: "endLine must be at or after startLine",
    path: ["endLine"],
  });
const WriteArgs = z
  .object({
    workspaceId: WorkspaceIdArg,
    path: PathArg,
    content: z.string().max(WS_LIMITS.maxWriteBytes).optional(),
    patch: z.string().min(1).max(WS_LIMITS.maxWriteBytes).optional(),
  })
  .refine((v) => (v.content === undefined) !== (v.patch === undefined), {
    message: "pass exactly one of content or patch",
    path: ["content"],
  });

// ---------------------------------------------------------------- next steps

const q = (s: string) => JSON.stringify(s);

export function workspaceToolCalls(ws: Pick<WorkspaceView, "workspaceId">) {
  const id = q(ws.workspaceId);
  return [
    {
      name: "ws_exec",
      call: `ws_exec({ workspaceId: ${id}, command: "pnpm test" })`,
      description: "Run a shell command in the checkout (exit code, bounded stdout/stderr).",
    },
    {
      name: "ws_read",
      call: `ws_read({ workspaceId: ${id}, path: "package.json" })`,
      description: "Read a file (optionally a line range).",
    },
    {
      name: "ws_write",
      call: `ws_write({ workspaceId: ${id}, path: "src/index.ts", content: "<new content>" })`,
      description: "Write a whole file, or apply a unified diff with `patch`.",
    },
    {
      name: "ws_diff",
      call: `ws_diff({ workspaceId: ${id} })`,
      description: "Your changes against the Change's base commit.",
    },
    {
      name: "ws_commit_push",
      call: `ws_commit_push({ workspaceId: ${id}, message: "<what and why>" })`,
      description:
        "Commit everything and push to the Change's fork: CI, evidence and the tour follow.",
    },
    {
      name: "close_workspace",
      call: `close_workspace({ workspaceId: ${id} })`,
      description: "Stop the workspace (uncommitted work is lost).",
    },
  ];
}

function viewOut(v: WorkspaceView) {
  return {
    workspaceId: v.workspaceId,
    changeId: v.changeId,
    repoId: v.repoId,
    forkName: v.forkName,
    branch: v.branch,
    baseSha: v.baseSha,
    headSha: v.headSha,
    status: v.status,
    network: v.network,
    expiresAt: v.expiresAt,
    idleSleepSec: v.idleSleepSec,
    restoredFrom: v.restoredFrom,
    usage: {
      containerSeconds: v.usage.containerSeconds,
      projectSecondsRemaining: v.usage.projectSecondsRemaining,
    },
  };
}

function openNextSteps(v: WorkspaceView) {
  const id = q(v.workspaceId);
  if (v.status === "starting") {
    return [
      {
        title: "The workspace is still starting: call open_workspace again in a few seconds",
        call: `open_workspace({ changeId: ${q(v.changeId)} })`,
        why: "The container boots and checks out the fork in the background; every ws_* call also waits for it.",
      },
    ];
  }
  return [
    {
      title: "Look around",
      call: `ws_exec({ workspaceId: ${id}, command: "git status && ls" })`,
    },
    {
      title: "Install dependencies if the workspace didn't start from a dependency snapshot",
      call: `ws_exec({ workspaceId: ${id}, command: "pnpm install --frozen-lockfile", timeoutSec: 300 })`,
      why:
        v.network === "registries-only"
          ? "This project's sandbox can only reach package registries."
          : "restoredFrom says whether node_modules is already there.",
    },
    {
      title: "Edit, test, then commit and push",
      call: `ws_commit_push({ workspaceId: ${id}, message: "<what and why>" })`,
    },
  ];
}

// ---------------------------------------------------------------- tools

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export function workspaceTools(backend: McpBackend, kit: ToolKit) {
  return [
    defineTool({
      name: "open_workspace",
      title: "Open a remote workspace",
      description:
        "A sandbox with your Change's fork checked out at its head, for agents without a local shell or git. Starts or resumes it (idempotent per Change; author only) and returns the ws_* tools to use. It sleeps when idle and ends at expiresAt.",
      inputSchema: OpenWorkspaceInput,
      outputSchema: OpenWorkspaceOutput,
      annotations: WRITE,
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "change:create");
        const { changeId } = kit.parse(z.object({ changeId: z.string().min(1).max(64) }), args);
        const v = await kit.run(backend, () =>
          backend.openWorkspace(caller, { changeId }, { idempotencyKey: args.idempotencyKey }),
        );
        return {
          ...viewOut(v),
          tools: workspaceToolCalls(v),
          nextSteps: openNextSteps(v),
        };
      },
    }),
    defineTool({
      name: "ws_exec",
      title: "Run a command in the workspace",
      description:
        "Runs `sh -c <command>` in the workspace checkout as the unprivileged runner user, with a hard timeout. Returns the exit code and stdout/stderr (each capped; the middle of long output is dropped).",
      inputSchema: WsExecInput,
      outputSchema: WsExecOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "change:create");
        const v = kit.parse(ExecArgs, {
          workspaceId: args.workspaceId,
          command: args.command,
          cwd: args.cwd,
          timeoutSec: args.timeoutSec,
        });
        const r = await kit.run(backend, () =>
          backend.wsExec(
            caller,
            {
              workspaceId: v.workspaceId,
              command: v.command,
              ...(v.cwd === undefined ? {} : { cwd: v.cwd }),
              ...(v.timeoutSec === undefined ? {} : { timeoutSec: v.timeoutSec }),
            },
            { idempotencyKey: args.idempotencyKey },
          ),
        );
        const nextSteps = r.timedOut
          ? [
              {
                title: "It timed out: run long jobs in the background and poll the log",
                call: `ws_exec({ workspaceId: ${q(v.workspaceId)}, command: "nohup sh -c '<command>' > /tmp/job.log 2>&1 & echo started" })`,
              },
            ]
          : [];
        return { ...r, nextSteps };
      },
    }),
    defineTool({
      name: "ws_read",
      title: "Read a file in the workspace",
      description:
        "Reads a file from the workspace checkout, optionally a 1-based inclusive line range. Large files are truncated (truncated: true); binary files come back empty with binary: true.",
      inputSchema: WsReadInput,
      outputSchema: WsReadOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "repo:read");
        const v = kit.parse(ReadArgs, args);
        return kit.run(backend, () =>
          backend.wsRead(caller, {
            workspaceId: v.workspaceId,
            path: v.path,
            ...(v.startLine === undefined ? {} : { startLine: v.startLine }),
            ...(v.endLine === undefined ? {} : { endLine: v.endLine }),
          }),
        );
      },
    }),
    defineTool({
      name: "ws_write",
      title: "Write a file in the workspace",
      description:
        "Writes a whole file (`content`, creating parent directories) or applies a unified diff to it (`patch`). Paths outside the repository are rejected. Nothing is committed until ws_commit_push.",
      inputSchema: WsWriteInput,
      outputSchema: WsWriteOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "change:create");
        const v = kit.parse(WriteArgs, {
          workspaceId: args.workspaceId,
          path: args.path,
          content: args.content,
          patch: args.patch,
        });
        const r = await kit.run(backend, () =>
          backend.wsWrite(
            caller,
            {
              workspaceId: v.workspaceId,
              path: v.path,
              ...(v.content === undefined ? {} : { content: v.content }),
              ...(v.patch === undefined ? {} : { patch: v.patch }),
            },
            { idempotencyKey: args.idempotencyKey },
          ),
        );
        return {
          ...r,
          nextSteps: [
            {
              title: "Run the tests",
              call: `ws_exec({ workspaceId: ${q(v.workspaceId)}, command: "pnpm test" })`,
            },
            { title: "Review your changes", call: `ws_diff({ workspaceId: ${q(v.workspaceId)} })` },
          ],
        };
      },
    }),
    defineTool({
      name: "ws_diff",
      title: "Diff the workspace",
      description:
        "Every change in the workspace (committed or not, new files included) against the Change's base commit: per-file stats and a unified diff (capped).",
      inputSchema: WsDiffInput,
      outputSchema: WsDiffOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "repo:read");
        const { workspaceId } = kit.parse(z.object({ workspaceId: WorkspaceIdArg }), args);
        const r = await kit.run(backend, () => backend.wsDiff(caller, workspaceId));
        return {
          ...r,
          nextSteps:
            r.files.length === 0
              ? [
                  {
                    title: "Nothing changed yet",
                    call: `ws_write({ workspaceId: ${q(workspaceId)}, path: "<file>", content: "<content>" })`,
                  },
                ]
              : [
                  {
                    title: "Commit and push",
                    call: `ws_commit_push({ workspaceId: ${q(workspaceId)}, message: "<what and why>" })`,
                  },
                ],
        };
      },
    }),
    defineTool({
      name: "ws_commit_push",
      title: "Commit and push the workspace",
      description:
        "Commits every change in the workspace (as you) and pushes it to the Change's fork branch. That push starts CI, evidence, the lane and the tour, exactly like a git push.",
      inputSchema: WsCommitPushInput,
      outputSchema: WsCommitPushOutput,
      annotations: WRITE,
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "change:create");
        const v = kit.parse(
          z.object({
            workspaceId: WorkspaceIdArg,
            message: z.string().min(1).max(WS_LIMITS.maxMessageChars),
          }),
          { workspaceId: args.workspaceId, message: args.message },
        );
        const r = await kit.run(backend, () =>
          backend.wsCommitPush(caller, v, { idempotencyKey: args.idempotencyKey }),
        );
        return {
          ...r,
          nextSteps: [
            {
              title: "Wait for CI and the signed evidence",
              call: `wait_for_change({ changeId: ${q(r.changeId)}, until: "evidence_ready" })`,
            },
            {
              title: "Then read the reviewer's tour",
              call: `get_tour({ changeId: ${q(r.changeId)} })`,
            },
          ],
        };
      },
    }),
    defineTool({
      name: "close_workspace",
      title: "Close the workspace",
      description:
        "Stops the workspace and deletes its sleep snapshot. Uncommitted changes are lost; the fork keeps everything you pushed. open_workspace starts a fresh one.",
      inputSchema: WorkspaceIdInput,
      outputSchema: CloseWorkspaceOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "change:create");
        const { workspaceId } = kit.parse(z.object({ workspaceId: WorkspaceIdArg }), {
          workspaceId: args.workspaceId,
        });
        const v = await kit.run(backend, () =>
          backend.closeWorkspace(caller, workspaceId, { idempotencyKey: args.idempotencyKey }),
        );
        return {
          ...viewOut(v),
          nextSteps: [
            {
              title: "Wait for the Change's evidence",
              call: `wait_for_change({ changeId: ${q(v.changeId)}, until: "evidence_ready" })`,
            },
          ],
        };
      },
    }),
  ] as const;
}
