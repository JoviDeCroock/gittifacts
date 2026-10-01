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
  ChangeStatusOutput,
  CreatePlanInput,
  CreatePlanOutput,
  EmptyInput,
  EvidenceOutput,
  IssuesOutput,
  ListReposOutput,
  RefreshPushTokenInput,
  RefreshPushTokenOutput,
  RequestReviewInput,
  RequestReviewOutput,
  StartChangeInput as StartChangeInputSchema,
  StartChangeOutput,
  TourOutput,
  WaitForChangeInput,
  WaitForChangeOutput,
  WhoamiOutput,
} from "./schemas.js";

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

/** What an agent should do next for a change in its current state. */
export function changeNextSteps(c: Change, runs: readonly PipelineRun[] = []): NextStep[] {
  const id = c.id;
  const wait = (until: string): NextStep => ({
    title: `Wait for ${until.replace("_", " ")}`,
    call: `wait_for_change({ changeId: "${id}", until: "${until}" })`,
  });
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

// ---------------------------------------------------------------- tools

export function buildTools(backend: McpBackend) {
  return defineTools([
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
      inputSchema: ChangeIdInput,
      outputSchema: ChangeStatusOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "repo:read");
        const { changeId } = parse(ChangeIdArgs, args);
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
          nextSteps: changeNextSteps(s.change, s.runs),
        };
      },
    },
    {
      name: "get_evidence",
      title: "Get evidence",
      description:
        "The signed evidence for the change's current head (tests, red/green proof, coverage, API diff, ...) and whether the signature verifies.",
      inputSchema: ChangeIdInput,
      outputSchema: EvidenceOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "repo:read");
        const { changeId } = parse(ChangeIdArgs, args);
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
      inputSchema: ChangeIdInput,
      outputSchema: TourOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "repo:read");
        const { changeId } = parse(ChangeIdArgs, args);
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
        "Long-poll until the change reaches a milestone (evidence_ready, lane_assigned, tour_ready, merged, reverted), can no longer reach it, or the timeout passes. Prefer this to polling.",
      inputSchema: WaitForChangeInput,
      outputSchema: WaitForChangeOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = callerOf(ctx);
        requireScope(caller, "repo:read");
        const v = parse(
          ChangeIdArgs.extend({
            until: WaitUntil,
            timeoutSec: z.number().int().min(1).max(600).default(50),
          }),
          args,
        );
        const r = await run(backend, () =>
          backend.waitForChange(caller, v.changeId, v.until, v.timeoutSec * 1000),
        );
        return {
          reached: r.reached,
          reason: r.reason,
          change: changeBrief(r.change),
          nextSteps: changeNextSteps(r.change),
        };
      },
    },
  ]);
}

export type PlatformTools = ReturnType<typeof buildTools>;
/** Same type `mcp-tada introspect` generates for the live server (see tools.introspection.d.ts). */
export type PlatformIntrospection = IntrospectionOf<PlatformTools>;
export type ToolName = keyof PlatformTools & string;
