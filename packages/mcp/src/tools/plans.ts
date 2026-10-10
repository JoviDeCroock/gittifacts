/**
 * Plans for agents: `get_plan` (a plan, the changes that implement it and what to do next),
 * `list_plans` (a repo's plans, by status or only yours) and `withdraw_plan` (the author drops its
 * own draft). Approving or rejecting a plan stays human-only: these tools never decide one.
 */
import type { Change, PlanStatus } from "@app/domain";
import { defineTool } from "mcp-tada-server";
import { z } from "zod";
import type { McpBackend, McpCaller, MutationOptions } from "../backend.js";
import { ChangeBrief } from "../schemas.js";
import { changeBrief } from "../tools.js";
import type { ToolKit } from "./workspace.js";

// ---------------------------------------------------------------- backend contract

/** A plan as the platform stores it (the domain Plan plus who rejected it, when, and why). */
export interface PlanData {
  id: string;
  repoId: string;
  title: string;
  intent: string;
  acceptanceCriteria: string[];
  outOfScope: string[];
  riskDeclarations: { area: string; description: string }[];
  scopePaths: string[];
  affectedRoutes: string[];
  status: PlanStatus;
  authorId: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  supersedes: string | null;
  createdAt: string;
}

export interface PrincipalRefData {
  id: string;
  name: string;
  kind: "human" | "agent" | "system" | "integration";
}

export interface PlanToolsBackend {
  /** A plan and the changes that implement it (read access to its repo). */
  getPlan(
    caller: McpCaller,
    planId: string,
  ): Promise<{ plan: PlanData; changes: Change[]; principals: Record<string, PrincipalRefData> }>;
  /** A repo's plans, newest first (read access). */
  listPlans(
    caller: McpCaller,
    repoId: string,
  ): Promise<{ plans: PlanData[]; principals: Record<string, PrincipalRefData> }>;
  /** The author withdraws its own draft (it ends as rejected, withdrawn by its author). */
  withdrawPlan(
    caller: McpCaller,
    planId: string,
    reason: string | undefined,
    opts: MutationOptions,
  ): Promise<PlanData>;
}

// ---------------------------------------------------------------- schemas

export const PLAN_STATUSES = [
  "draft",
  "approved",
  "superseded",
  "rejected",
] as const satisfies readonly PlanStatus[];

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;
const strings = { type: "array", items: str } as const;
const id = { type: "string", minLength: 1, maxLength: 64 } as const;
const url = {
  type: "string",
  description: "The plan's page on the platform: hand it to the person who approves it.",
} as const;
const NextSteps = {
  type: "array",
  description: "What to do next, as concrete tool calls (call).",
  items: {
    type: "object",
    properties: { title: str, call: str, why: str },
    required: ["title"],
  },
} as const;
const Principal = {
  type: ["object", "null"],
  properties: {
    id: str,
    name: str,
    kind: { enum: ["human", "agent", "system", "integration"] },
  },
  required: ["id", "name", "kind"],
} as const;

const PlanBrief = {
  type: "object",
  properties: {
    id: str,
    repoId: str,
    title: str,
    status: { enum: PLAN_STATUSES },
    authorId: str,
    approvedBy: nullableStr,
    approvedAt: nullableStr,
    rejectionReason: nullableStr,
    scopePaths: strings,
    supersedes: nullableStr,
    createdAt: str,
    url,
  },
  required: [
    "id",
    "repoId",
    "title",
    "status",
    "authorId",
    "approvedBy",
    "approvedAt",
    "rejectionReason",
    "scopePaths",
    "supersedes",
    "createdAt",
    "url",
  ],
} as const;

const PlanFull = {
  type: "object",
  properties: {
    ...PlanBrief.properties,
    intent: str,
    acceptanceCriteria: strings,
    outOfScope: strings,
    riskDeclarations: {
      type: "array",
      items: {
        type: "object",
        properties: { area: str, description: str },
        required: ["area", "description"],
      },
    },
    affectedRoutes: strings,
    rejectedBy: nullableStr,
    rejectedAt: nullableStr,
  },
  required: [
    ...PlanBrief.required,
    "intent",
    "acceptanceCriteria",
    "outOfScope",
    "riskDeclarations",
    "affectedRoutes",
    "rejectedBy",
    "rejectedAt",
  ],
} as const;

const GetPlanInput = {
  type: "object",
  properties: { planId: id },
  required: ["planId"],
  additionalProperties: false,
} as const;

const ListPlansInput = {
  type: "object",
  properties: {
    repoId: id,
    status: { enum: PLAN_STATUSES, description: "Only plans with this status." },
    mine: { type: "boolean", description: "Only plans you drafted." },
  },
  required: ["repoId"],
  additionalProperties: false,
} as const;

const WithdrawPlanInput = {
  type: "object",
  properties: {
    planId: id,
    reason: {
      type: "string",
      maxLength: 2000,
      description: "Why (recorded in the plan's audit log).",
    },
    idempotencyKey: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Optional. Retrying with the same key returns the first result instead of acting twice.",
    },
  },
  required: ["planId"],
  additionalProperties: false,
} as const;

const GetPlanOutput = {
  type: "object",
  properties: {
    plan: PlanFull,
    author: { ...Principal, description: "Who drafted it." },
    approver: { ...Principal, description: "The person who approved it (null until then)." },
    changes: { type: "array", items: ChangeBrief, description: "Changes started from this plan." },
    url,
    nextSteps: NextSteps,
  },
  required: ["plan", "author", "approver", "changes", "url", "nextSteps"],
} as const;

const ListPlansOutput = {
  type: "object",
  properties: { plans: { type: "array", items: PlanBrief } },
  required: ["plans"],
} as const;

const WithdrawPlanOutput = {
  type: "object",
  properties: { plan: PlanBrief, nextSteps: NextSteps },
  required: ["plan", "nextSteps"],
} as const;

// ---------------------------------------------------------------- shaping and next steps

type NextStep = { title: string; call?: string; why?: string };
const q = (s: string) => JSON.stringify(s);

export function planBrief(p: PlanData, url: string) {
  return {
    id: p.id,
    repoId: p.repoId,
    title: p.title,
    status: p.status,
    authorId: p.authorId,
    approvedBy: p.approvedBy,
    approvedAt: p.approvedAt,
    rejectionReason: p.rejectionReason,
    scopePaths: p.scopePaths,
    supersedes: p.supersedes,
    createdAt: p.createdAt,
    url,
  };
}

/** What `viewerId` should do next with plan `p` (pure; `url` is the plan's page). */
export function planNextSteps(p: PlanData, viewerId: string, url: string): NextStep[] {
  const planId = q(p.id);
  switch (p.status) {
    case "draft":
      if (p.authorId !== viewerId) {
        return [{ title: `A person approves or rejects this draft at ${url}` }];
      }
      return [
        {
          title: `Ask a person to approve it at ${url}`,
          why: "Humans approve intent: someone other than you approves it; agents never can.",
        },
        { title: "Check whether it was approved", call: `get_plan({ planId: ${planId} })` },
        {
          title: "No longer wanted? Withdraw your draft",
          call: `withdraw_plan({ planId: ${planId}, reason: "<why>" })`,
        },
      ];
    case "approved":
      return [
        {
          title: "Approved: start the change",
          call: `start_change({ repoId: ${q(p.repoId)}, planId: ${planId}, title: ${q(p.title)}, category: "feature" })`,
        },
      ];
    case "rejected":
      return [
        {
          title:
            p.rejectedBy === p.authorId
              ? "Withdrawn by its author: draft a new plan if the work is still wanted"
              : "Rejected: draft a new plan that answers the reason, if the work is still wanted",
          ...(p.rejectionReason ? { why: p.rejectionReason.slice(0, 600) } : {}),
          call: `create_plan({ repoId: ${q(p.repoId)}, title: "<title>", intent: "<why>", acceptanceCriteria: ["<observable result>"] })`,
        },
      ];
    case "superseded":
      return [
        {
          title: "Superseded by a newer plan: work from the approved one",
          call: `list_plans({ repoId: ${q(p.repoId)}, status: "approved" })`,
        },
      ];
  }
}

// ---------------------------------------------------------------- tools

const PlanIdArgs = z.object({ planId: z.string().min(1).max(64) });
const ListPlansArgs = z.object({
  repoId: z.string().min(1).max(64),
  status: z.enum(PLAN_STATUSES).optional(),
  mine: z.boolean().optional(),
});
const WithdrawArgs = PlanIdArgs.extend({ reason: z.string().max(2000).optional() });

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export function planTools(backend: McpBackend, kit: ToolKit) {
  const urlOf = (planId: string) => backend.webUrl({ planId });
  return [
    defineTool({
      name: "get_plan",
      title: "Get a plan",
      description:
        "A plan: its intent, acceptance criteria and scope, its status (draft until a person approves it; agents never can), who drafted and approved it, the changes started from it, its page (url) to hand a person, and what to do next. Call it to see whether your draft was approved.",
      inputSchema: GetPlanInput,
      outputSchema: GetPlanOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "repo:read");
        const { planId } = kit.parse(PlanIdArgs, args);
        const d = await kit.run(backend, () => backend.getPlan(caller, planId));
        const url = urlOf(d.plan.id);
        const ref = (id: string | null) => (id === null ? null : (d.principals[id] ?? null));
        return {
          plan: {
            ...planBrief(d.plan, url),
            intent: d.plan.intent,
            acceptanceCriteria: d.plan.acceptanceCriteria,
            outOfScope: d.plan.outOfScope,
            riskDeclarations: d.plan.riskDeclarations.map((r) => ({
              area: r.area,
              description: r.description,
            })),
            affectedRoutes: d.plan.affectedRoutes,
            rejectedBy: d.plan.rejectedBy,
            rejectedAt: d.plan.rejectedAt,
          },
          author: ref(d.plan.authorId),
          approver: ref(d.plan.approvedBy),
          changes: d.changes.map(changeBrief),
          url,
          nextSteps: planNextSteps(d.plan, caller.principalId, url),
        };
      },
    }),
    defineTool({
      name: "list_plans",
      title: "List plans",
      description:
        "A repo's plans, newest first, each with its status and page (url). Filter by status (draft, approved, superseded, rejected) or to the plans you drafted (mine: true).",
      inputSchema: ListPlansInput,
      outputSchema: ListPlansOutput,
      annotations: READ,
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "repo:read");
        const { repoId, status, mine } = kit.parse(ListPlansArgs, args);
        const { plans } = await kit.run(backend, () => backend.listPlans(caller, repoId));
        return {
          plans: plans
            .filter((p) => status === undefined || p.status === status)
            .filter((p) => mine !== true || p.authorId === caller.principalId)
            .map((p) => planBrief(p, urlOf(p.id))),
        };
      },
    }),
    defineTool({
      name: "withdraw_plan",
      title: "Withdraw your plan",
      description:
        "Withdraw a draft plan you drafted yourself (it ends as rejected, withdrawn by its author; the reason is audited). Only the author, and only a draft: approving or rejecting anyone's plan stays with people.",
      inputSchema: WithdrawPlanInput,
      outputSchema: WithdrawPlanOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "plan:create");
        const { planId, reason } = kit.parse(WithdrawArgs, {
          planId: args.planId,
          reason: args.reason,
        });
        const plan = await kit.run(backend, () =>
          backend.withdrawPlan(caller, planId, reason, { idempotencyKey: args.idempotencyKey }),
        );
        const url = urlOf(plan.id);
        return {
          plan: planBrief(plan, url),
          nextSteps: planNextSteps(plan, caller.principalId, url),
        };
      },
    }),
  ];
}
