/**
 * QA in a browser, on request (docs/research/agentic-qa.md): `request_qa` asks for a run on the
 * change's current head (idempotent per head, rate-limited per repo), `get_qa` reads the runs.
 * A run's verdicts are evidence: a failure raises the lane, nothing lowers it.
 */
import { defineTool } from "mcp-tada-server";
import { z } from "zod";
import type { McpBackend, McpCaller, MutationOptions } from "../backend.js";
import { GITHUB_REF_PATTERN } from "../schemas.js";
import type { ToolKit } from "./workspace.js";

// ---------------------------------------------------------------- backend contract

export interface QaRunBrief {
  id: string;
  changeId: string;
  headSha: string;
  status: "queued" | "running" | "done" | "failed";
  progress: string | null;
  summary: { passed: number; failed: number; couldntTest: number } | null;
  laneBefore: number | null;
  laneAfter: number | null;
  costUsd: number | null;
  wallMs: number | null;
  error: string | null;
  criteria: Array<{ text: string; verdict: "pass" | "fail" | "couldnt-test"; reason: string }>;
  /** Step screenshots and the replay GIF: blob refs (GET /api/v1/blobs/{ref}). */
  artifacts: Array<{ name: string; ref: string; role: string }>;
  reportUrl: string;
}

export interface QaToolsBackend {
  requestQa?(
    caller: McpCaller,
    changeId: string,
    input: { force?: boolean },
    opts: MutationOptions,
  ): Promise<{ run: QaRunBrief; reused: boolean }>;
  listQa?(caller: McpCaller, changeId: string): Promise<QaRunBrief[]>;
}

// ---------------------------------------------------------------- schemas

const ref = {
  changeId: { type: "string", minLength: 1, maxLength: 64 },
  github: {
    type: "string",
    pattern: GITHUB_REF_PATTERN,
    description:
      "GitHub mode: the pull request as owner/repo#123, instead of changeId (pass exactly one).",
  },
} as const;

const RequestQaInput = {
  type: "object",
  properties: {
    ...ref,
    force: {
      type: "boolean",
      description:
        "Run again although this head already has a finished run (counts against the repo's limit).",
    },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
  },
  additionalProperties: false,
} as const;
const GetQaInput = { type: "object", properties: ref, additionalProperties: false } as const;

const nullableNum = { type: ["number", "null"] } as const;
const RunBrief = {
  type: "object",
  properties: {
    id: { type: "string" },
    changeId: { type: "string" },
    headSha: { type: "string" },
    status: { enum: ["queued", "running", "done", "failed"] },
    progress: { type: ["string", "null"] },
    summary: {
      type: ["object", "null"],
      properties: {
        passed: { type: "number" },
        failed: { type: "number" },
        couldntTest: { type: "number" },
      },
    },
    laneBefore: nullableNum,
    laneAfter: nullableNum,
    costUsd: nullableNum,
    wallMs: nullableNum,
    error: { type: ["string", "null"] },
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          verdict: { enum: ["pass", "fail", "couldnt-test"] },
          reason: { type: "string" },
        },
        required: ["text", "verdict", "reason"],
      },
    },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, ref: { type: "string" }, role: { type: "string" } },
        required: ["name", "ref", "role"],
      },
    },
    reportUrl: { type: "string" },
  },
  required: [
    "id",
    "changeId",
    "headSha",
    "status",
    "progress",
    "summary",
    "laneBefore",
    "laneAfter",
    "costUsd",
    "wallMs",
    "error",
    "criteria",
    "artifacts",
    "reportUrl",
  ],
} as const;
const NextSteps = {
  type: "array",
  items: {
    type: "object",
    properties: { title: { type: "string" }, call: { type: "string" }, why: { type: "string" } },
    required: ["title"],
  },
} as const;
const RequestQaOutput = {
  type: "object",
  properties: { run: RunBrief, reused: { type: "boolean" }, nextSteps: NextSteps },
  required: ["run", "reused", "nextSteps"],
} as const;
const GetQaOutput = {
  type: "object",
  properties: { runs: { type: "array", items: RunBrief }, nextSteps: NextSteps },
  required: ["runs", "nextSteps"],
} as const;

const RefArgs = z
  .object({
    changeId: z.string().min(1).max(64).optional(),
    github: z.string().regex(new RegExp(GITHUB_REF_PATTERN)).optional(),
  })
  .refine((a) => (a.changeId === undefined) !== (a.github === undefined), {
    message: "pass exactly one of changeId or github",
  });

const q = (s: string) => JSON.stringify(s);

function nextSteps(run: QaRunBrief): Array<{ title: string; call?: string; why?: string }> {
  if (run.status === "queued" || run.status === "running") {
    return [
      {
        title: "Read the result when it finishes (usually 1–3 minutes)",
        call: `get_qa({ changeId: ${q(run.changeId)} })`,
      },
    ];
  }
  if (run.status === "failed")
    return [
      {
        title: "QA could not test this head",
        why: run.error ?? "see the report",
        call: `get_change_status({ changeId: ${q(run.changeId)} })`,
      },
    ];
  if ((run.summary?.failed ?? 0) > 0) {
    return [
      {
        title: "Fix what QA found, push, then ask again",
        why: "a failed criterion raised the lane to Full review",
        call: `request_qa({ changeId: ${q(run.changeId)} })`,
      },
    ];
  }
  return [
    { title: "Hand it to a person", call: `request_review({ changeId: ${q(run.changeId)} })` },
  ];
}

export function qaTools(backend: McpBackend, kit: ToolKit) {
  const changeIdOf = async (
    caller: McpCaller,
    args: { changeId?: string | undefined; github?: string | undefined },
  ) => {
    if (args.changeId !== undefined) return args.changeId;
    const resolve = backend.resolveGithubChange;
    if (resolve === undefined || args.github === undefined)
      throw kit.failure("not-found", "this platform does not grade GitHub pull requests", {
        explanation: "Pass changeId instead.",
      });
    const github = args.github;
    return kit.run(backend, () => resolve.call(backend, caller, github));
  };
  const unavailable = () =>
    kit.failure("upstream", "QA runs are not available on this platform", {
      explanation: "Ask a human to review the change instead.",
    });
  return [
    defineTool({
      name: "request_qa",
      title: "Ask for QA in a browser",
      description:
        "On request only: an agent drives the app built from the change's current head in a real browser against the Plan's acceptance criteria (no Plan: a smoke check), with a screenshot per step, a replay GIF and a pass / fail / couldn't-test verdict per criterion, signed into the evidence. A failure raises the lane; nothing lowers it. Needs green CI on the head. Idempotent per head (force: run again); at most 6 runs an hour per repo.",
      inputSchema: RequestQaInput,
      outputSchema: RequestQaOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "change:create");
        const changeId = await changeIdOf(
          caller,
          kit.parse(RefArgs, { changeId: args.changeId, github: args.github }),
        );
        if (backend.requestQa === undefined) throw unavailable();
        const requestQa = backend.requestQa;
        const out = await kit.run(backend, () =>
          requestQa.call(backend, caller, changeId, args.force === true ? { force: true } : {}, {
            idempotencyKey: args.idempotencyKey,
          }),
        );
        return { run: out.run, reused: out.reused, nextSteps: nextSteps(out.run) };
      },
    }),
    defineTool({
      name: "get_qa",
      title: "QA results",
      description:
        "The change's QA runs, newest first: status, verdict per criterion with the reason, the lane before and after, cost, and the screenshots' blob refs.",
      inputSchema: GetQaInput,
      outputSchema: GetQaOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "repo:read");
        const changeId = await changeIdOf(caller, kit.parse(RefArgs, args));
        if (backend.listQa === undefined) throw unavailable();
        const listQa = backend.listQa;
        const runs = await kit.run(backend, () => listQa.call(backend, caller, changeId));
        const latest = runs[0];
        return {
          runs,
          nextSteps:
            latest === undefined
              ? [{ title: "Ask for QA", call: `request_qa({ changeId: ${q(changeId)} })` }]
              : nextSteps(latest),
        };
      },
    }),
  ];
}
