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
  Id,
  type PipelineRun,
  PlanDraftInput,
  type Scope,
  StartChangeInput,
  WaitUntil,
} from "@app/domain";
import { defineTools, type IntrospectionOf, type ToolExtra } from "mcp-tada-server";
import { z } from "zod";
import type { McpBackend, McpCaller } from "./backend.js";
import {
  ChangeIdInput,
  ChangeRefInput,
  GITHUB_REF_PATTERN,
  ChangeStatusOutput,
  CloseChangeInput,
  CloseChangeOutput,
  CreatePlanInput,
  CreatePlanOutput,
  CreateProjectInput,
  CreateProjectOutput,
  EmptyInput,
  EvidenceOutput,
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
import { importTools } from "./tools/import.js";
import { queueTools } from "./tools/queue.js";
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
    laneReasons: c.laneReasons.map((r) => ({ code: r.code, lane: r.lane, message: r.message })),
    baseSha: c.baseSha,
    headSha: c.headSha,
    forkName: c.forkName,
    mergedSha: c.mergedSha,
    revertOf: c.revertOf,
    updatedAt: c.updatedAt,
  };
}

type NextStep = { title: string; call?: string; why?: string };

/** The platform-authored bootstrap Change of a project (first CI + preview; @app/coordinator ids). */
export function isBootstrap(c: Pick<Change, "id" | "authorId">): boolean {
  return c.id.startsWith("bs-") && c.authorId === "system";
}

/** What an agent should do next for a change in its current state. */
export function changeNextSteps(c: Change, runs: readonly PipelineRun[] = []): NextStep[] {
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
          why: "This is the project's own pipeline on its initial commit; fix it in a Change.",
          call: `get_change_status({ changeId: "${id}" })`,
        },
        rerun,
      ];
    }
  }
  switch (c.status) {
    case "awaiting-push":
      return [
        {
          title: `Push your commits to branch ${c.forkName} of the fork`,
          why: "Nothing has been pushed yet; CI starts on push.",
          call: `refresh_push_token({ changeId: "${id}" })`,
        },
      ];
    case "running":
      // Follow the milestones the current head has already passed.
      if (c.lane !== null) return [wait("tour_ready", "Lane assigned: wait for the tour")];
      if (c.evidenceId !== null) return [wait("lane_assigned", "Evidence sealed: wait for the lane")];
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
    case "awaiting-review":
      return [
        { title: "Read the tour a human will review", call: `get_tour({ changeId: "${id}" })` },
        { title: "Ask a human to review it", call: `request_review({ changeId: "${id}" })` },
      ];
    case "approved":
    case "queued":
      return [wait("merged")];
    case "merged":
    case "rolling-out":
      return [
        {
          title: "Watch for production issues",
          call: `list_issues_for_change({ changeId: "${id}" })`,
        },
      ];
    case "reverted":
      return [
        { title: "See what broke", call: `list_issues_for_change({ changeId: "${id}" })` },
        {
          title: "Start a follow-up change",
          call: `start_change({ repoId: "${c.repoId}", title: "<title>", category: "fix" })`,
        },
      ];
    default:
      return [];
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const ChangeIdArgs = z.object({ changeId: Id });

/** `changeId`, or (GitHub mode) `github: "owner/repo#123"`: exactly one. */
const ChangeRefArgs = z
  .object({ changeId: Id.optional(), github: z.string().regex(new RegExp(GITHUB_REF_PATTERN)).optional() })
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
    message: "importMode push creates an empty project: no template or from",
    path: ["importMode"],
  });

export function buildTools(backend: McpBackend) {
  return defineTools([
    {
      name: "create_project",
      title: "Create a project",
      description:
        "One call: a repo from a template (or an import, or empty) with .platform/ci.ts, .platform/policy.ts and AGENTS.md committed, the first CI run and preview started, and a push grant for your first Change's fork; it returns at once (wait_for_change on bootstrapChangeId for the first green). " +
        // Same sentence as @app/conventions ANONYMOUS_RECONNECT (tested there).
        "Without credentials it creates an unclaimed project and returns its token. Reconnect with `Authorization: Bearer <token>` (the `token` field in this response). Every other tool needs it, and this project's tools are unavailable without it.",
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
        "Your principal, scopes, the repos you can act on (with claim status and allowed actions) and quotas. Call this first.",
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
          scopes: [...w.principal.scopes],
          canApprove: w.canApprove,
          repos: w.repos.map((r) => ({
            id: r.id,
            name: r.name,
            claim: r.claim,
            actions: r.actions,
          })),
          quotas: w.quotas,
        };
      },
    },
    {
      name: "list_repos",
      title: "List repos",
      description:
        "Repos you can read, with open changes per lane and whether Lane 0 (auto-merge) is on.",
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
        "Draft a plan: intent, acceptance criteria and the paths you expect to touch. A human other than you approves it before you start a change. Returns the plan id.",
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
        return {
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
              title: "Ask a human to approve the plan",
              why: "Humans approve intent; you cannot approve your own plan.",
            },
            {
              title: "Then start the change",
              call: `start_change({ repoId: "${plan.repoId}", planId: "${plan.id}", title: "${plan.title.replaceAll('"', "'")}", category: "feature" })`,
            },
          ],
        };
      },
    },
    {
      name: "start_change",
      title: "Start a change",
      description:
        "Fork the repo for one change and get a short-lived push grant for that fork only. Push commits there; CI, evidence and the lane follow automatically.",
      inputSchema: StartChangeInputSchema,
      outputSchema: StartChangeOutput,
      annotations: WRITE,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "change:create");
        const { idempotencyKey, ...rest } = args;
        const input = parse(StartChangeInput, rest);
        const { change, remote } = await run(backend, () =>
          backend.startChange(caller, input, { idempotencyKey }),
        );
        return {
          change: changeBrief(change),
          remote,
          nextSteps: [
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
    {
      name: "get_change_status",
      title: "Get change status",
      description:
        "A change's status, lane (and why), pipeline runs for each head, and what to do next.",
      inputSchema: ChangeRefInput,
      outputSchema: ChangeStatusOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "repo:read");
        const changeId = await changeIdOf(backend, caller, parse(ChangeRefArgs, args));
        const s = await run(backend, () => backend.getChangeStatus(caller, changeId));
        return {
          change: changeBrief(s.change),
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
                reasons: s.classification.reasons.map((r) => ({
                  code: r.code,
                  lane: r.lane,
                  message: r.message,
                })),
              }
            : null,
          previewUrl: s.previewUrl ?? null,
          nextSteps: changeNextSteps(s.change, s.runs),
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
        };
      },
    },
    {
      name: "get_tour",
      title: "Get the review tour",
      description:
        "The reviewer agent's guided tour of the change (what a human will read): stops with verdicts, least-confident points and what was not done.",
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
        };
      },
    },
    {
      name: "request_review",
      title: "Request a human review",
      description:
        "Ask a human to look at your change (notifies them). This never approves anything: agents cannot approve plans or changes.",
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
          notified: r.notified,
          nextSteps: [
            {
              title: "Wait for the review",
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
        "Repeats CI, evidence, the lane and the tour on the change's current head, without a push (a flaky step). Author, its owner or a maintainer; only while the change is running, failing or awaiting review.",
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
        "A fresh short-lived push grant for your change's fork (author only). Use it when the old token expired.",
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
        "Long-poll until the change's current head reaches a milestone, can no longer reach it, or the timeout passes. Prefer this to polling. reached=true means the milestone holds now: evidence_ready = CI finished (passed or failed) and its signed evidence is sealed (a bootstrap Change: also released when green, failing when not); lane_assigned = the lane is set (status stays running while the tour is written); tour_ready = the tour is written and the change is routed (awaiting-review, or queued); merged = on the default branch; reverted = reverted. On timeout call again, after retryAfterSec when it is set.",
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
        return {
          reached: r.reached,
          reason: r.reason,
          ...(r.reason === "timeout" ? { retryAfterSec: r.retryAfterSec ?? 0 } : {}),
          change: changeBrief(r.change),
          nextSteps: changeNextSteps(r.change),
        };
      },
    },
    // Remote workspaces and import detection (one file per tool family, sharing these helpers).
    ...workspaceTools(backend, { callerOf, requireScope, parse, run, failure }),
    ...importTools(backend, { callerOf, requireScope, parse, run, failure }),
    ...queueTools(backend, { callerOf, requireScope, parse, run, failure }),
  ]);
}

export type PlatformTools = ReturnType<typeof buildTools>;
/** Same type `mcp-tada introspect` generates for the live server (see tools.introspection.d.ts). */
export type PlatformIntrospection = IntrospectionOf<PlatformTools>;
export type ToolName = keyof PlatformTools & string;
