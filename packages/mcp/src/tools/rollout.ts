/**
 * `get_rollout`: what happened to a change after merge, the same view as its rollout page: the
 * staged rollout (stages, error rate against the previous version, new issue groups), the flag
 * that switches it off, the policy it was held to (read from its base) and its audit timeline.
 * Read-only: switching a change off stays with people.
 */
import type { Change, RolloutPolicy, RolloutState } from "@app/domain";
import { defineTool } from "mcp-tada-server";
import { z } from "zod";
import type { McpBackend, McpCaller } from "../backend.js";
import { GITHUB_REF_PATTERN } from "../schemas.js";
import { changeNextSteps } from "../tools.js";
import { AuditEvent, type AuditEventData } from "./audit.js";
import type { ToolKit } from "./workspace.js";

// ---------------------------------------------------------------- backend contract

export interface RolloutToolsBackend {
  /** A change's rollout, the policy from its base and its audit timeline (read access). */
  getRollout(
    caller: McpCaller,
    changeId: string,
  ): Promise<{
    change: Change;
    rollout: RolloutState | null;
    policy: RolloutPolicy;
    policySha: string | null;
    /** Oldest first. */
    timeline: AuditEventData[];
  }>;
}

// ---------------------------------------------------------------- schemas

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;
const nullableNum = { type: ["number", "null"] } as const;

const GetRolloutInput = {
  type: "object",
  properties: {
    changeId: { type: "string", minLength: 1, maxLength: 64 },
    github: {
      type: "string",
      pattern: GITHUB_REF_PATTERN,
      description:
        "GitHub mode: the pull request as owner/repo#123, instead of changeId (pass exactly one).",
    },
  },
  additionalProperties: false,
} as const;

const Rollout = {
  type: ["object", "null"],
  description: "null: no rollout (not merged yet, or the repo has no deploy target).",
  properties: {
    status: {
      enum: ["pending", "rolling", "watching", "released", "rolling-back", "rolled-back", "failed"],
    },
    versionId: nullableStr,
    previousVersionId: nullableStr,
    stages: {
      type: "array",
      items: {
        type: "object",
        properties: { percent: { type: "integer" }, startedAt: nullableStr, completedAt: nullableStr },
        required: ["percent", "startedAt", "completedAt"],
      },
    },
    watchUntil: nullableStr,
    flagKey: { ...nullableStr, description: "The flag a person switches off to disable the change." },
    lastCheck: {
      type: ["object", "null"],
      properties: {
        at: str,
        errorRate: nullableNum,
        baselineErrorRate: nullableNum,
        requests: { type: "integer" },
        newIssueGroups: { type: "integer" },
      },
      required: ["at", "errorRate", "baselineErrorRate", "requests", "newIssueGroups"],
    },
  },
  required: [
    "status",
    "versionId",
    "previousVersionId",
    "stages",
    "watchUntil",
    "flagKey",
    "lastCheck",
  ],
} as const;

const GetRolloutOutput = {
  type: "object",
  properties: {
    changeId: str,
    status: { type: "string", description: "The change's status (merged, rolling-out, released, reverted, ...)." },
    mergedSha: nullableStr,
    revertedBy: { ...nullableStr, description: "The revert change, once a regression rolled it back." },
    rollout: Rollout,
    policy: {
      type: "object",
      description: "The rollout policy from the change's base (.platform/policy.ts), not the repo's current one.",
      properties: {
        stages: { type: "array", items: { type: "integer" } },
        stageMinutes: { type: "integer" },
        watchMinutes: { type: "integer" },
        maxErrorRateIncrease: { type: "number" },
        maxNewIssueGroups: { type: "integer" },
        minRequests: { type: "integer" },
      },
      required: ["stages", "stageMinutes", "watchMinutes", "maxErrorRateIncrease", "maxNewIssueGroups", "minRequests"],
    },
    policySha: nullableStr,
    timeline: { type: "array", description: "The change's audit events, oldest first.", items: AuditEvent },
    url: { type: "string", description: "The change's rollout page, to hand a person." },
    nextSteps: {
      type: "array",
      items: {
        type: "object",
        properties: { title: str, call: str, why: str },
        required: ["title"],
      },
    },
  },
  required: [
    "changeId",
    "status",
    "mergedSha",
    "revertedBy",
    "rollout",
    "policy",
    "policySha",
    "timeline",
    "url",
    "nextSteps",
  ],
} as const;

const GetRolloutArgs = z
  .object({
    changeId: z.string().min(1).max(64).optional(),
    github: z.string().regex(new RegExp(GITHUB_REF_PATTERN)).optional(),
  })
  .refine((a) => (a.changeId === undefined) !== (a.github === undefined), {
    message: "pass exactly one of changeId or github",
  });

// ---------------------------------------------------------------- tool

export function rolloutTools(
  backend: McpBackend,
  kit: ToolKit & {
    changeIdOf(
      caller: McpCaller,
      args: { changeId?: string | undefined; github?: string | undefined },
    ): Promise<string>;
  },
) {
  return [
    defineTool({
      name: "get_rollout",
      title: "Get a change's rollout",
      description:
        "After merge: the staged rollout of the change (stages, error rate against the previous version, new issue groups, the flag that switches it off), the policy it was held to (from its base) and its audit timeline. rollout is null before merge or without a deploy target. A regression rolls it back and opens a revert change (revertedBy). Read-only: switching a change off is a person's act.",
      inputSchema: GetRolloutInput,
      outputSchema: GetRolloutOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "repo:read");
        const changeId = await kit.changeIdOf(caller, kit.parse(GetRolloutArgs, args));
        const r = await kit.run(backend, () => backend.getRollout(caller, changeId));
        const p = r.policy;
        return {
          changeId: r.change.id,
          status: r.change.status,
          mergedSha: r.change.mergedSha,
          revertedBy: r.change.revertedBy,
          rollout: r.rollout,
          policy: {
            stages: [...p.stages],
            stageMinutes: p.stageMinutes,
            watchMinutes: p.watchMinutes,
            maxErrorRateIncrease: p.maxErrorRateIncrease,
            maxNewIssueGroups: p.maxNewIssueGroups,
            minRequests: p.minRequests,
          },
          policySha: r.policySha,
          timeline: r.timeline,
          url: backend.webUrl({ changeId: r.change.id, view: "rollout" }),
          nextSteps: changeNextSteps(r.change),
        };
      },
    }),
  ];
}
