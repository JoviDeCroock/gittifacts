/**
 * The gittifacts MCP tools, declared once with mcp-tada-server: JSON Schema in, typed handler,
 * JSON Schema out (agents get typed `structuredContent`).
 *
 * Every handler: (1) reads the bearer principal from `ctx.http.authInfo`, (2) checks the scope,
 * (3) zod-parses the arguments into domain types (defence in depth on top of the JSON Schema
 * check), (4) calls the backend, (5) shapes the result. A failure is an `isError` result whose text
 * is the platform's error envelope as JSON: `{ error: { code, message, fix, details? } }`.
 */
import {
  type ApiError,
  type Change,
  groupLaneReasons,
  Id,
  type LaneReason,
  type OverlapReport,
  openPushIssues,
  orderLaneReasons,
  type PipelineRun,
  PlanDraftInput,
  type PushIssue,
  pushIssueFix,
  type Scope,
  StartChangeInput,
  WaitUntil,
} from "@app/domain";
import { defineTools, type IntrospectionOf, type ToolExtra } from "mcp-tada-server";
import { z } from "zod";
import type { ChangeReviewData, McpBackend, McpCaller, ResolutionData } from "./backend.js";
import {
  ChangeIdInput,
  ChangeRefInput,
  ChangeStatusOutput,
  CloseChangeInput,
  CloseChangeOutput,
  CreatePlanInput,
  CreatePlanOutput,
  CreateProjectInput,
  CreateProjectOutput,
  EmptyInput,
  EvidenceOutput,
  GITHUB_REF_PATTERN,
  IssuesOutput,
  ListMembersOutput,
  ListReposOutput,
  RefreshPushTokenInput,
  RefreshPushTokenOutput,
  RepoIdInput,
  RequestReviewInput,
  RequestReviewOutput,
  RerunCiInput,
  RerunCiOutput,
  StartChangeInput as StartChangeInputSchema,
  StartChangeOutput,
  TourOutput,
  WaitForChangeInput,
  WaitForChangeOutput,
  WhoamiOutput,
} from "./schemas.js";
import { attemptTools } from "./tools/attempts.js";
import { auditTools } from "./tools/audit.js";
import { changeListTools } from "./tools/changes.js";
import { codeTools } from "./tools/code.js";
import { importTools } from "./tools/import.js";
import { planTools } from "./tools/plans.js";
import { qaTools } from "./tools/qa.js";
import { queueTools } from "./tools/queue.js";
import { rolloutTools } from "./tools/rollout.js";
import { workspaceTools } from "./tools/workspace.js";

// ---------------------------------------------------------------- errors

/** Thrown inside a handler; mcp-tada-server turns the message (the JSON envelope) into the result. */
export class ToolFailure extends Error {
  constructor(readonly envelope: ApiError) {
    super(JSON.stringify(envelope));
    this.name = "ToolFailure";
  }
}

function failure(
  code: string,
  message: string,
  fix: ApiError["error"]["fix"],
  details?: unknown,
): ToolFailure {
  return new ToolFailure({
    error: { code, message, fix, ...(details !== undefined ? { details } : {}) },
  });
}

/** Parse an MCP tool error result's text back into the envelope (for clients and tests). */
export function parseToolError(text: string): ApiError | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && "error" in v) return v as ApiError;
  } catch {
    // not an envelope (e.g. a JSON Schema input error from the SDK layer)
  }
  return null;
}

function callerOf(ctx: ToolExtra): McpCaller {
  const authInfo = ctx.http?.authInfo;
  if (!authInfo) {
    throw failure("unauthorized", "no bearer token on this request", {
      explanation:
        "Call the MCP endpoint with `Authorization: Bearer gtf_…` (an agent token a human created for you).",
    });
  }
  return { principalId: authInfo.clientId, scopes: authInfo.scopes, authInfo };
}

function requireScope(caller: McpCaller, scope: Scope): void {
  if (!caller.scopes.includes(scope)) {
    throw failure(
      "insufficient-scope",
      `missing scope: ${scope}`,
      {
        explanation: `This tool needs the ${scope} scope. Ask the human who owns this agent to grant it, or hand this step to them.`,
        call: "whoami({})",
      },
      { required: [scope], missing: [scope] },
    );
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw failure(
      "invalid-request",
      "arguments failed validation",
      { explanation: "`details` lists each argument and what is wrong; fix them and call again." },
      r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
  return r.data;
}

async function run<T>(backend: McpBackend, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ToolFailure) throw e;
    throw new ToolFailure(backend.errorEnvelope(e));
  }
}

// ---------------------------------------------------------------- shaping

export function changeBrief(c: Change) {
  return {
    id: c.id,
    repoId: c.repoId,
    planId: c.planId,
    title: c.title,
    category: c.claim.category,
    status: c.status,
    lane: c.lane,
    computedLane: c.computedLane,
    // Reading order: the reasons that set the lane first, passing checks last.
    laneReasons: orderLaneReasons(c.laneReasons).map(reasonBrief),
    baseSha: c.baseSha,
    headSha: c.headSha,
    forkName: c.forkName,
    mergedSha: c.mergedSha,
    revertOf: c.revertOf,
    updatedAt: c.updatedAt,
  };
}

const reasonBrief = (r: LaneReason) => ({ code: r.code, lane: r.lane, message: r.message });

/** Why the change is in its lane, compact: deciding reasons + passing count (null: no lane yet). */
export function laneSummaryOf(c: Change) {
  if (c.lane === null) return null;
  const g = groupLaneReasons(c.laneReasons);
  return { lane: c.lane, deciding: g.deciding.map(reasonBrief), passingCount: g.passing.length };
}

/** Ignored fork pushes still worth telling the agent about, each with its fix. */
export function pushIssuesOf(c: Change, issues: readonly PushIssue[] | undefined) {
  return openPushIssues(issues, c.headSha).map((i) => ({ ...i, fix: pushIssueFix(i, c.id) }));
}

type NextStep = { title: string; call?: string; command?: string; why?: string };

/** The newest ignored push comes first in nextSteps: the agent's work never reached CI. */
function pushIssueSteps(issues: ReturnType<typeof pushIssuesOf>): NextStep[] {
  const last = issues.at(-1);
  if (last === undefined) return [];
  const branch = last.expectedRef.replace(/^refs\/heads\//, "");
  return [
    {
      title: clip(`Your push to ${last.ref} graded nothing: push to ${branch} of the fork`, 200),
      why: clip(`${last.why} ${last.fix.explanation}`),
      ...(last.fix.command === undefined ? {} : { command: last.fix.command }),
    },
  ];
}

/** start_change: say who else is on the same plan or paths before the agent writes code. */
function overlapSteps(report: OverlapReport | null): NextStep[] {
  if (report === null) return [];
  const first = report.overlaps[0];
  if (first === undefined) return [];
  const n = report.overlaps.length + report.moreOverlaps;
  const who = `${first.title} (${first.author.name})`;
  return [
    {
      title:
        n === 1
          ? `Another open change overlaps yours: ${who}`
          : `${n} open changes overlap yours, first ${who}`,
      call: `get_change_status({ changeId: "${first.changeId}" })`,
      why: `${first.reasons.map((r) => r.message).join("; ")}. Coordinate with its author or wait for it to merge before touching the same paths.`,
    },
  ];
}

/** What next steps read of a review (`get_change_status` passes them; `wait_for_change` doesn't). */
export type ReviewBrief = Pick<
  ChangeReviewData,
  "decision" | "comment" | "headSha" | "reviewer" | "withdrawn"
>;

const clip = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The newest review of `headSha` with `decision`, if any (reviews come oldest first). */
function newest(
  reviews: readonly ReviewBrief[],
  decision: ReviewBrief["decision"],
  headSha: string | null,
): ReviewBrief | undefined {
  for (let i = reviews.length - 1; i >= 0; i--) {
    const r = reviews[i];
    if (r?.decision === decision && (headSha === null || r.headSha === headSha)) return r;
  }
  return undefined;
}

/** A reviewer sent the pushed head back: address it, push a new head, ask again. */
function changesRequestedSteps(c: Change, reviews: readonly ReviewBrief[]): NextStep[] {
  const id = c.id;
  const sha = (c.headSha ?? "").slice(0, 7);
  const r = newest(reviews, "request-changes", c.headSha);
  const by = r === undefined ? "" : ` by ${r.reviewer.name}`;
  const read: NextStep =
    r === undefined
      ? {
          title: `Changes requested on ${sha}: read the reviewer's comment (reviews)`,
          call: `get_change_status({ changeId: "${id}" })`,
        }
      : r.comment
        ? { title: `Changes requested on ${sha}${by}: address the comment`, why: clip(r.comment) }
        : {
            title: `Changes requested on ${sha}${by} (no comment): read the walkthrough again`,
            call: `get_tour({ changeId: "${id}" })`,
          };
  return [
    read,
    {
      title: `Push a new head to branch ${c.forkName} of the fork`,
      why: "CI, evidence, the lane and the walkthrough run again for it; the old head's review no longer counts.",
      call: `refresh_push_token({ changeId: "${id}" })`,
    },
    {
      title: "Once it is graded, ask for the review again",
      call: `request_review({ changeId: "${id}" })`,
    },
  ];
}

/** A person picked another attempt at the same plan, which closed this change. */
function supersededSteps(c: Change, by: string | null): NextStep[] {
  return [
    {
      title: `A person picked another attempt at this plan${by === null ? "" : ` (${by})`}; this change was closed`,
      why: "Nothing more to do here. Compare the attempts to see why.",
      ...(c.planId === null ? {} : { call: `compare_attempts({ planId: "${c.planId}" })` }),
    },
  ];
}

/** The platform-authored bootstrap Change of a project (first CI + preview; @app/coordinator ids). */
export function isBootstrap(c: Pick<Change, "id" | "authorId">): boolean {
  return c.id.startsWith("bs-") && c.authorId === "system";
}

/**
 * What an agent should do next for a change in its current state. With `reviews` (oldest first)
 * the steps quote what a reviewer said; without them they point at get_change_status.
 */
export function changeNextSteps(
  c: Change,
  runs: readonly PipelineRun[] = [],
  reviews: readonly ReviewBrief[] = [],
): NextStep[] {
  const id = c.id;
  const wait = (until: string, title?: string): NextStep => ({
    title: title ?? `Wait for ${until.replace("_", " ")}`,
    call: `wait_for_change({ changeId: "${id}", until: "${until}" })`,
  });
  const rerun: NextStep = {
    title: "If the failure looks flaky, re-run CI on the same head (no push needed)",
    call: `rerun_ci({ changeId: "${id}", reason: "<why>" })`,
  };
  if (isBootstrap(c)) {
    // The first CI run and preview of a new project: no lane, no tour, no review.
    if (c.status === "running") return [wait("evidence_ready", "Wait for the first green")];
    if (c.status === "released") {
      return [
        {
          title: "The first CI run is green and the preview is up: start your first Change",
          call: `start_change({ repoId: "${c.repoId}", title: "<what>", category: "feature" })`,
        },
      ];
    }
    if (c.status === "failing") {
      return [
        {
          title: "The first CI run failed: read the failing step",
          why: "This is the repo's own pipeline on its initial commit; fix it in a Change.",
          call: `get_change_status({ changeId: "${id}" })`,
        },
        rerun,
      ];
    }
  }
  switch (c.status) {
    case "awaiting-push":
      // A head was pushed and graded, then sent back by a reviewer.
      if (c.headSha !== null) return changesRequestedSteps(c, reviews);
      return [
        {
          title: `Push your commits to branch ${c.forkName} of the fork`,
          why: "Nothing has been pushed yet; CI starts on push.",
          call: `refresh_push_token({ changeId: "${id}" })`,
        },
      ];
    case "running":
      // Follow the milestones the current head has already passed.
      if (c.lane !== null) return [wait("tour_ready", "Lane assigned: wait for the walkthrough")];
      if (c.evidenceId !== null)
        return [wait("lane_assigned", "Evidence sealed: wait for the lane")];
      return [wait("evidence_ready")];
    case "failing": {
      const failed = runs[0]?.steps.filter((s) => s.status === "failed").map((s) => s.name) ?? [];
      return [
        {
          title:
            failed.length > 0
              ? `Fix the failing step(s): ${failed.join(", ")} and push again`
              : "Fix CI and push again",
          why: "A new push starts a new pipeline for the new head.",
          call: `get_change_status({ changeId: "${id}" })`,
        },
        rerun,
        {
          title: "Or close it if it won't merge",
          call: `close_change({ changeId: "${id}", reason: "<why>" })`,
        },
      ];
    }
    case "awaiting-review": {
      const lost = reviews.find(
        (r) => r.decision === "approve" && r.headSha === c.headSha && r.withdrawn !== null,
      );
      const withdrawn: NextStep[] =
        lost === undefined
          ? []
          : [
              {
                title: `The approval by ${lost.reviewer.name} was withdrawn (${lost.withdrawn?.reason ?? "withdrawn"}): it needs a fresh review`,
                why: "Fix what failed and push a new head, or ask a person to review this head again.",
                ...(lost.withdrawn?.reason === "qa-failed"
                  ? { call: `get_qa({ changeId: "${id}" })` }
                  : {}),
              },
            ];
      return [
        ...withdrawn,
        {
          title: "Read the walkthrough a human will review",
          call: `get_tour({ changeId: "${id}" })`,
        },
        { title: "Ask a human to review it", call: `request_review({ changeId: "${id}" })` },
      ];
    }
    case "approved":
    case "queued":
      return [wait("merged")];
    case "merged":
    case "rolling-out":
      return [
        {
          title: "Watch the rollout: stages, error rate and the flag",
          call: `get_rollout({ changeId: "${id}" })`,
        },
        wait("reverted", "Wait for a revert, in case a regression rolls it back"),
        {
          title: "Watch for production issues",
          call: `list_issues_for_change({ changeId: "${id}" })`,
        },
      ];
    case "released":
      return [
        {
          title: "Released: watch for production issues",
          call: `list_issues_for_change({ changeId: "${id}" })`,
        },
      ];
    case "rejected": {
      const r = newest(reviews, "reject", null);
      return [
        {
          title: `Rejected${r === undefined ? "" : ` by ${r.reviewer.name}`}: this change ended`,
          ...(r?.comment ? { why: clip(r.comment) } : {}),
          call: `start_change({ repoId: "${c.repoId}", title: "<title>", category: "${c.claim.category}" })`,
        },
      ];
    }
    case "reverted":
      return [
        { title: "See what broke", call: `list_issues_for_change({ changeId: "${id}" })` },
        { title: "See what the rollout measured", call: `get_rollout({ changeId: "${id}" })` },
        {
          title: "Start a follow-up change",
          call: `start_change({ repoId: "${c.repoId}", title: "<title>", category: "fix" })`,
        },
      ];
    default:
      return [];
  }
}

/** The merge queue rewrote what lands: say so before anything else (get_change_status, queue_status). */
export function resolutionSteps(changeId: string, r: ResolutionData | null): NextStep[] {
  if (r === null) return [];
  const pushed =
    r.originalHeadSha === null ? "your head" : `your head ${r.originalHeadSha.slice(0, 7)}`;
  const steps: NextStep[] = [
    {
      title: `The merge queue resolved a ${r.kind} conflict: ${r.headSha.slice(0, 7)} lands, not ${pushed}`,
      why: `Files: ${r.files.join(", ") || "none listed"}. A new push replaces the resolution and the queue resolves again; the resolution diff is in the evidence (conflict-resolution item).`,
      call: `get_evidence({ changeId: "${changeId}" })`,
    },
  ];
  if (r.approvalRequested) {
    steps.push({
      title: "A person must approve the resolution before it lands",
      call: `request_review({ changeId: "${changeId}" })`,
    });
  }
  return steps;
}

/** get_tour: prove the unproven stops, wait out a stale walkthrough, then hand it off. */
function tourNextSteps(
  changeId: string,
  stops: readonly { title: string; verdict: string }[],
  stale: boolean,
): NextStep[] {
  if (stale) {
    return [
      {
        title: "This walkthrough is for an older head: wait for the new one",
        call: `wait_for_change({ changeId: "${changeId}", until: "tour_ready" })`,
      },
    ];
  }
  const unproven = stops.filter((s) => s.verdict === "unproven");
  return [
    ...(unproven.length === 0
      ? []
      : [
          {
            title: `Turn ${unproven.length} unproven stop(s) into proven ones: add tests or evidence and push`,
            why: clip(unproven.map((s) => s.title).join("; ")),
            call: `refresh_push_token({ changeId: "${changeId}" })`,
          },
        ]),
    { title: "Ask a human to review it", call: `request_review({ changeId: "${changeId}" })` },
  ];
}

/** whoami: who answers for you and where they see you, then where to start. */
function whoamiNextSteps(
  w: { principal: { kind: string; ownerId: string | null }; ownerName: string | null },
  agentsUrl: string,
): NextStep[] {
  const owner: NextStep[] =
    w.principal.kind === "agent" && w.principal.ownerId !== null
      ? [
          {
            title: `${w.ownerName ?? "Your owner"} answers for you and can inspect or revoke you at ${agentsUrl}`,
          },
        ]
      : [];
  return [...owner, { title: "See the repos you can act on", call: "list_repos({})" }];
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const ChangeIdArgs = z.object({ changeId: Id });

/** `changeId`, or (GitHub mode) `github: "owner/repo#123"`: exactly one. */
const ChangeRefArgs = z
  .object({
    changeId: Id.optional(),
    github: z.string().regex(new RegExp(GITHUB_REF_PATTERN)).optional(),
  })
  .refine((a) => (a.changeId === undefined) !== (a.github === undefined), {
    message: "pass exactly one of changeId or github",
  });

/** The change id a tool call names (a GitHub PR is resolved by the backend). */
async function changeIdOf(
  backend: McpBackend,
  caller: McpCaller,
  args: { changeId?: string | undefined; github?: string | undefined },
): Promise<string> {
  if (args.changeId !== undefined) return args.changeId;
  const resolve = backend.resolveGithubChange;
  if (resolve === undefined || args.github === undefined) {
    throw failure("not-found", "this platform does not grade GitHub pull requests", {
      explanation: "Pass changeId instead.",
    });
  }
  const ref = args.github;
  return run(backend, () => resolve.call(backend, caller, ref));
}

// ---------------------------------------------------------------- tools

const CreateProjectArgs = z
  .object({
    name: z.string().min(1).max(63).optional(),
    template: z.string().min(1).max(100).optional(),
    from: z.string().url().startsWith("https://").max(500).optional(),
    description: z.string().max(500).optional(),
    importMode: z.enum(["push"]).optional(),
  })
  .refine((v) => v.template === undefined || v.from === undefined, {
    message: "pass template or from, not both",
    path: ["from"],
  })
  .refine((v) => v.importMode === undefined || (v.template ?? v.from) === undefined, {
    message: "importMode push creates an empty repo: no template or from",
    path: ["importMode"],
  });

export function buildTools(backend: McpBackend) {
  const kit = { callerOf, requireScope, parse, run, failure };
  return defineTools([
    {
      name: "create_project",
      title: "Create a repo",
      description:
        "One call: a repo from a template (or an import, or empty) with .platform/ci.ts, .platform/policy.ts and AGENTS.md committed, the first CI run and preview started, and a push token for your first Change's fork; it returns at once (wait_for_change on bootstrapChangeId for the first green). " +
        // Same sentence as @app/conventions ANONYMOUS_RECONNECT (tested there).
        "Without credentials it creates an unclaimed repo and returns its token. Reconnect with `Authorization: Bearer <token>` (the `token` field in this response). Every other tool needs it, and this repo's tools are unavailable without it.",
      inputSchema: CreateProjectInput,
      outputSchema: CreateProjectOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        // Unclaimed (credential-less) creation arrives with O3; until then: repo:read +
        // change:create, and the project belongs to the human (or the agent's owner).
        requireScope(caller, "repo:read");
        requireScope(caller, "change:create");
        const { idempotencyKey, ...rest } = args;
        const input = parse(CreateProjectArgs, rest);
        const out = await run(backend, () =>
          backend.createProject(caller, input, { idempotencyKey }),
        );
        return {
          ...out,
          nextSteps: out.nextSteps.map((s) => ({
            title: s.title,
            ...(s.call === undefined ? {} : { call: s.call }),
            ...(s.command === undefined ? {} : { command: s.command }),
            ...(s.why === undefined ? {} : { why: s.why }),
          })),
        };
      },
    },
    {
      name: "whoami",
      title: "Who am I",
      description:
        "Who you are (your actor: principalId, kind, and for an agent the person accountable for you, ownerName, with the page where they inspect or revoke you, agentsUrl), scopes, the repos you can act on (with claim status and allowed actions) and quotas. Call this first.",
      inputSchema: EmptyInput,
      outputSchema: WhoamiOutput,
      annotations: READ,
      handler: async (_args, ctx) => {
        const caller = callerOf(ctx);
        const w = await run(backend, () => backend.whoami(caller));
        return {
          principalId: w.principal.id,
          kind: w.principal.kind,
          name: w.principal.name,
          ownerId: w.principal.ownerId,
          ownerName: w.ownerName,
          agentsUrl: backend.webUrl({ agents: true }),
          scopes: [...w.principal.scopes],
          canApprove: w.canApprove,
          repos: w.repos.map((r) => ({
            id: r.id,
            name: r.name,
            claim: r.claim,
            actions: r.actions,
          })),
          quotas: w.quotas,
          nextSteps: whoamiNextSteps(w, backend.webUrl({ agents: true })),
        };
      },
    },
    {
      name: "list_repos",
      title: "List repos",
      description:
        "Repos you can read, with open changes per lane and whether auto-merge (Lane 0) is on or still calibrating.",
      inputSchema: EmptyInput,
      outputSchema: ListReposOutput,
      annotations: READ,
      handler: async (_args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "repo:read");
        const repos = await run(backend, () => backend.listRepos(caller));
        return {
          repos: repos.map((r) => ({
            id: r.id,
            name: r.name,
            defaultBranch: r.defaultBranch,
            lane0Enabled: r.policy.lane0Enabled,
            claim: r.claim,
            counts: r.counts,
            cloneUrl: r.cloneUrl ?? null,
          })),
        };
      },
    },
    {
      name: "list_members",
      title: "List repo members",
      description:
        "A repo's human members and their roles (reader < reviewer < maintainer < owner), and your role (an agent acts with its owner's role: reviewer or above to draft plans and start changes). Ask an owner listed here for access.",
      inputSchema: RepoIdInput,
      outputSchema: ListMembersOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "repo:read");
        const { repoId } = parse(z.object({ repoId: Id }), args);
        const m = await run(backend, () => backend.listMembers(caller, repoId));
        return {
          repoId: m.repoId,
          members: m.members.map((x) => ({
            principalId: x.principalId,
            name: x.name,
            role: x.role,
            addedAt: x.addedAt,
          })),
          yourRole: m.viewerRole,
        };
      },
    },
    {
      name: "create_plan",
      title: "Create a plan",
      description:
        "Draft a plan: intent, acceptance criteria and the paths you expect to touch. A human other than you approves it before you start a change. Returns the plan id and its page (url) to hand that person; get_plan shows when it is approved.",
      inputSchema: CreatePlanInput,
      outputSchema: CreatePlanOutput,
      annotations: WRITE,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "plan:create");
        const { idempotencyKey, ...draft } = args;
        const input = parse(PlanDraftInput, draft);
        const plan = await run(backend, () =>
          backend.createPlan(caller, input, { idempotencyKey }),
        );
        const url = backend.webUrl({ planId: plan.id });
        return {
          url,
          plan: {
            id: plan.id,
            repoId: plan.repoId,
            title: plan.title,
            status: plan.status,
            authorId: plan.authorId,
            scopePaths: plan.scopePaths,
            supersedes: plan.supersedes,
            createdAt: plan.createdAt,
          },
          nextSteps: [
            {
              title: `Ask a person to approve the plan at ${url}`,
              why: "Humans approve intent; you cannot approve your own plan (no agent can).",
            },
            {
              title: "Check whether it was approved",
              call: `get_plan({ planId: "${plan.id}" })`,
            },
            {
              title: "Then start the change",
              call: `start_change({ repoId: "${plan.repoId}", planId: "${plan.id}", title: "${plan.title.replaceAll('"', "'")}", category: "feature" })`,
            },
          ],
        };
      },
    },
    // Reading and withdrawing plans (approving them stays with people).
    ...planTools(backend, kit),
    {
      name: "start_change",
      title: "Start a change",
      description:
        "Fork the repo for one change and get a short-lived push token for that fork only. Push commits there; CI, evidence and the lane follow automatically. overlaps lists the open changes already on the same plan or touching the paths you name (paths) or your plan's scopePaths: coordinate with them or wait. url is the change's page, to hand a person. A plan still in draft is fine to start from, but the change can't auto-merge until a person approves the plan.",
      inputSchema: StartChangeInputSchema,
      outputSchema: StartChangeOutput,
      annotations: WRITE,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "change:create");
        const { idempotencyKey, ...rest } = args;
        const input = parse(StartChangeInput, rest);
        const { change, remote, overlaps } = await run(backend, () =>
          backend.startChange(caller, input, { idempotencyKey }),
        );
        return {
          change: changeBrief(change),
          remote,
          url: backend.webUrl({ changeId: change.id }),
          overlaps,
          nextSteps: [
            ...overlapSteps(overlaps),
            {
              title: `Push your work to ${remote.branch}`,
              why: "Authenticate git with remote.token as a Bearer header (the token includes its ?expires= suffix; don't put it in the URL).",
              command: `git -c http.extraHeader="Authorization: Bearer $GITTIFACTS_PUSH_TOKEN" push ${remote.url} HEAD:refs/heads/${remote.branch}`,
            },
            {
              title: "Wait for evidence",
              call: `wait_for_change({ changeId: "${change.id}", until: "evidence_ready" })`,
            },
          ],
        };
      },
    },
    // A repo's changes (by status, or only yours).
    ...changeListTools(backend, kit),
    // Several attempts at one plan, ranked (a person picks one).
    ...attemptTools(backend, kit),
    {
      name: "get_change_status",
      title: "Get change status",
      description:
        "A change's status, lane (and why), pipeline runs for each head, the human reviews (decision, comment, reviewer, head; a withdrawn approval says why), who started it (author, with an agent's accountable person), the open changes on the same plan or paths (overlaps), the merge queue's conflict resolution when what lands differs from your head (resolution), its page (url) to hand a person, and what to do next.",
      inputSchema: ChangeRefInput,
      outputSchema: ChangeStatusOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "repo:read");
        const changeId = await changeIdOf(backend, caller, parse(ChangeRefArgs, args));
        const [s, resolution] = await run(backend, () =>
          Promise.all([
            backend.getChangeStatus(caller, changeId),
            backend.getResolution(caller, changeId),
          ]),
        );
        const issues = pushIssuesOf(s.change, s.pushIssues);
        return {
          change: changeBrief(s.change),
          url: backend.webUrl({ changeId: s.change.id }),
          author: s.author,
          resolution,
          reviews: s.reviews.map((r) => ({
            id: r.id,
            decision: r.decision,
            comment: r.comment,
            headSha: r.headSha,
            current: r.headSha === s.change.headSha,
            reviewer: { id: r.reviewer.id, name: r.reviewer.name, kind: r.reviewer.kind },
            at: r.at,
            withdrawn: r.withdrawn !== null,
            withdrawnReason: r.withdrawn?.reason ?? null,
          })),
          runs: s.runs.map((r) => ({
            id: r.id,
            headSha: r.headSha,
            status: r.status,
            steps: r.steps.map((st) => ({
              name: st.name,
              kind: st.kind,
              status: st.status,
              logRef: st.logRef,
            })),
          })),
          classification: s.classification
            ? {
                lane: s.classification.lane,
                computedLane: s.classification.computedLane,
                shadow: s.classification.shadow,
                blocked: s.classification.blocked,
                requiresHumanApproval: s.classification.requiresHumanApproval,
                reasons: orderLaneReasons(s.classification.reasons).map(reasonBrief),
              }
            : null,
          previewUrl: s.previewUrl ?? null,
          overlaps: s.overlaps,
          supersededBy: s.supersededBy ?? null,
          laneSummary: laneSummaryOf(s.change),
          pushIssues: issues,
          nextSteps:
            s.supersededBy != null
              ? supersededSteps(s.change, s.supersededBy)
              : [
                  ...pushIssueSteps(issues),
                  ...resolutionSteps(s.change.id, resolution),
                  ...changeNextSteps(s.change, s.runs, s.reviews),
                ],
        };
      },
    },
    {
      name: "get_evidence",
      title: "Get evidence",
      description:
        "The signed evidence for the change's current head (tests, red/green proof, coverage, API diff, ...) and whether the signature verifies.",
      inputSchema: ChangeRefInput,
      outputSchema: EvidenceOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "repo:read");
        const changeId = await changeIdOf(backend, caller, parse(ChangeRefArgs, args));
        const { evidence, verification } = await run(backend, () =>
          backend.getEvidence(caller, changeId),
        );
        return {
          changeId: evidence.changeId,
          headSha: evidence.headSha,
          verification,
          signedAt: evidence.attestation.signedAt,
          keyId: evidence.attestation.keyId,
          items: evidence.items,
          url: backend.webUrl({ changeId: evidence.changeId, view: "evidence" }),
          nextSteps: verification.ok
            ? [
                {
                  title: "Read the walkthrough written from this evidence",
                  call: `get_tour({ changeId: "${evidence.changeId}" })`,
                },
              ]
            : [
                {
                  title: `The signature does not verify (${verification.reason ?? "unknown"}): don't rely on these items`,
                  why: "Tell a person (hand them url); a new push seals fresh evidence.",
                },
              ],
        };
      },
    },
    {
      name: "get_tour",
      title: "Get the review walkthrough",
      description:
        "The walkthrough (the tour) a second reviewer agent wrote for the change, what a human will read: stops with verdicts, least-confident points and what was not done.",
      inputSchema: ChangeRefInput,
      outputSchema: TourOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "repo:read");
        const changeId = await changeIdOf(backend, caller, parse(ChangeRefArgs, args));
        const { tour, stale } = await run(backend, () => backend.getTour(caller, changeId));
        return {
          tour: {
            id: tour.id,
            headSha: tour.headSha,
            stops: tour.stops.map((s) => ({
              kind: s.kind,
              title: s.title,
              why: s.why,
              verdict: s.verdict,
              hunkRefs: s.hunkRefs.map((h) => ({
                file: h.file,
                startLine: h.startLine,
                endLine: h.endLine,
                side: h.side,
              })),
              evidenceRefs: s.evidenceRefs,
            })),
            leastConfident: tour.leastConfident,
            notDone: tour.notDone,
          },
          stale,
          url: backend.webUrl({ changeId }),
          nextSteps: tourNextSteps(changeId, tour.stops, stale),
        };
      },
    },
    {
      name: "request_review",
      title: "Request a human review",
      description:
        "Ask for a human review of your change. The request is recorded in the change's audit log (the dashboard's agent band shows it), but nobody receives a message: hand url, the change's page, to a person. This never approves anything: agents cannot approve plans or changes.",
      inputSchema: RequestReviewInput,
      outputSchema: RequestReviewOutput,
      annotations: WRITE,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "change:create");
        const { changeId, message } = parse(
          ChangeIdArgs.extend({ message: z.string().max(2000).optional() }),
          { changeId: args.changeId, message: args.message },
        );
        const r = await run(backend, () =>
          backend.requestReview(caller, changeId, message, { idempotencyKey: args.idempotencyKey }),
        );
        return {
          changeId: r.change.id,
          status: r.change.status,
          requested: r.requested,
          url: backend.webUrl({ changeId: r.change.id }),
          nextSteps: [
            {
              title: `Hand a person the change's page: ${backend.webUrl({ changeId: r.change.id })}`,
              why: "No message is sent: the request is only recorded. Any member who may review (not you) can approve.",
            },
            {
              title: "Wait for the review",
              why: 'It answers early when a reviewer sends the change back (reason "changes-requested", "rejected" or "approval-withdrawn"): then read the reviews in get_change_status.',
              call: `wait_for_change({ changeId: "${r.change.id}", until: "merged" })`,
            },
          ],
        };
      },
    },
    {
      name: "rerun_ci",
      title: "Re-run CI",
      description:
        "Repeats CI, evidence, the lane and the walkthrough on the change's current head, without a push (a flaky step). Author, its owner or a maintainer; only while the change is running, failing or awaiting review.",
      inputSchema: RerunCiInput,
      outputSchema: RerunCiOutput,
      annotations: WRITE,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "change:create");
        const { changeId, reason } = parse(
          ChangeIdArgs.extend({ reason: z.string().max(2000).optional() }),
          { changeId: args.changeId, reason: args.reason },
        );
        const r = await run(backend, () =>
          backend.rerunCi(caller, changeId, reason, { idempotencyKey: args.idempotencyKey }),
        );
        return {
          change: changeBrief(r.change),
          headSha: r.headSha,
          nextSteps: [
            {
              title: "Wait for the new run's evidence",
              call: `wait_for_change({ changeId: "${r.change.id}", until: "evidence_ready" })`,
            },
          ],
        };
      },
    },
    {
      name: "close_change",
      title: "Close a change",
      description:
        "Close (abandon) a change that won't merge: stops its CI, takes it out of the merge queue and deletes its fork later. Author, its owner or a maintainer; the reason is audited. A merged change can't be closed.",
      inputSchema: CloseChangeInput,
      outputSchema: CloseChangeOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "change:create");
        const { changeId, reason } = parse(
          ChangeIdArgs.extend({ reason: z.string().max(2000).optional() }),
          { changeId: args.changeId, reason: args.reason },
        );
        const change = await run(backend, () =>
          backend.closeChange(caller, changeId, reason, { idempotencyKey: args.idempotencyKey }),
        );
        return {
          change: changeBrief(change),
          url: backend.webUrl({ changeId: change.id }),
          nextSteps: [
            {
              title: "Start a new change for this work, if any",
              call: `start_change({ repoId: "${change.repoId}", title: "<what>", category: "feature" })`,
            },
          ],
        };
      },
    },
    {
      name: "list_issues_for_change",
      title: "List production issues for a change",
      description:
        "Workers Issues attributed to the change or the version it rolled out (errors seen in production).",
      inputSchema: ChangeIdInput,
      outputSchema: IssuesOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "repo:read");
        const { changeId } = parse(ChangeIdArgs, args);
        const issues = await run(backend, () => backend.listIssuesForChange(caller, changeId));
        return {
          issues: issues.map((i) => ({
            id: i.id,
            title: i.title,
            count: i.count,
            firstSeen: i.firstSeen,
            lastSeen: i.lastSeen,
            versionId: i.versionId,
            url: i.url,
          })),
        };
      },
    },
    {
      name: "refresh_push_token",
      title: "Refresh the push token",
      description:
        "A fresh short-lived push token for your change's fork (author only). Use it when the old token expired.",
      inputSchema: RefreshPushTokenInput,
      outputSchema: RefreshPushTokenOutput,
      annotations: WRITE,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "change:create");
        const { changeId } = parse(ChangeIdArgs, args);
        const remote = await run(backend, () => backend.refreshPushToken(caller, changeId, {}));
        return { remote };
      },
    },
    {
      name: "wait_for_change",
      title: "Wait for a change",
      description:
        "Long-poll until the change's current head reaches a milestone, can no longer reach it, or the timeout passes. Prefer this to polling. reached=true means the milestone holds now: evidence_ready = CI finished (passed or failed) and its signed evidence is sealed (a first Change: also released when green, failing when not); lane_assigned = the lane is set (status stays running while the walkthrough is written); tour_ready = the walkthrough is written and the change is routed (awaiting-review, or queued); merged = on the default branch; reverted = reverted. A human can send it back first, reason changes-requested (push a new head), rejected (it ended) or approval-withdrawn (it needs a fresh review); a person can pick another attempt at the same plan, which closes this one, reason superseded (supersededBy); and for merged and reverted so can the machines, reason failing (red CI, a merge-queue ejection or a failed merge: fix and push a new head); read get_change_status for why. On timeout call again, after retryAfterSec when it is set; prefer this to wait_for_merge, which watches only the merge queue.",
      inputSchema: WaitForChangeInput,
      outputSchema: WaitForChangeOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "repo:read");
        const v = parse(
          z
            .object({
              changeId: Id.optional(),
              github: z.string().regex(new RegExp(GITHUB_REF_PATTERN)).optional(),
              until: WaitUntil,
              timeoutSec: z.number().int().min(1).max(600).default(50),
            })
            .refine((a) => (a.changeId === undefined) !== (a.github === undefined), {
              message: "pass exactly one of changeId or github",
            }),
          args,
        );
        const changeId = await changeIdOf(backend, caller, v);
        const r = await run(backend, () =>
          backend.waitForChange(caller, changeId, v.until, v.timeoutSec * 1000),
        );
        const by = r.reason === "superseded" ? (r.supersededBy ?? null) : null;
        const issues = pushIssuesOf(r.change, r.pushIssues);
        const last = issues.at(-1);
        // Waiting again would only time out again: the pushes went where nothing grades them.
        const warning =
          r.reason === "timeout" && last !== undefined
            ? `Timed out, and your last push graded nothing: ${last.why} Run pushIssues[].fix.command, then wait again.`
            : undefined;
        return {
          reached: r.reached,
          reason: r.reason,
          ...(r.reason === "timeout" ? { retryAfterSec: r.retryAfterSec ?? 0 } : {}),
          ...(by !== null ? { supersededBy: by } : {}),
          change: changeBrief(r.change),
          url: backend.webUrl({ changeId: r.change.id }),
          laneSummary: laneSummaryOf(r.change),
          pushIssues: issues,
          ...(warning === undefined ? {} : { warning }),
          nextSteps:
            r.reason === "superseded"
              ? supersededSteps(r.change, by)
              : [...pushIssueSteps(issues), ...changeNextSteps(r.change)],
        };
      },
    },
    // Remote workspaces and import detection (one file per tool family, sharing these helpers).
    ...workspaceTools(backend, kit),
    ...importTools(backend, kit),
    ...queueTools(backend, kit),
    // QA in a browser, on request.
    ...qaTools(backend, kit),
    // After merge (rollout) and the signed audit log: read-only.
    ...rolloutTools(backend, {
      ...kit,
      changeIdOf: (caller, args) => changeIdOf(backend, caller, args),
    }),
    ...auditTools(backend, kit),
    // A repo's code and history: read-only, the views people browse.
    ...codeTools(backend, kit),
  ]);
}

export type PlatformTools = ReturnType<typeof buildTools>;
/** Same type `mcp-tada introspect` generates for the live server (see tools.introspection.d.ts). */
export type PlatformIntrospection = IntrospectionOf<PlatformTools>;
export type ToolName = keyof PlatformTools & string;
