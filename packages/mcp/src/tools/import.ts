/**
 * Import detection (onboarding §3 "Imported repos"): `propose_platform_config` asks the platform
 * to detect how an imported repo builds and tests, and to propose `.platform/ci.ts`,
 * `.platform/policy.ts` and `AGENTS.md` as a Plan (authored by the platform, draft) plus a Change
 * on a fork with those files. A human approves both; nothing is applied silently, and the Change
 * is Lane 2 because it touches `.platform/**`. Until it merges, CI uses the detected defaults.
 *
 * The detection runs in a sandbox, so the proposal is asynchronous: the tool starts it (or finds
 * the one for the current default-branch commit) and waits up to `waitSec` for it.
 */
import { defineTool } from "mcp-tada-server";
import { z } from "zod";
import type { McpBackend, McpCaller, MutationOptions } from "../backend.js";
import type { ToolKit } from "./workspace.js";

/** `not-needed`: the repo already has every file the platform would propose. */
export type ProposalStatus = "running" | "proposed" | "not-needed" | "failed";

export interface ProposalView {
  proposalId: string;
  repoId: string;
  status: ProposalStatus;
  /** Default-branch commit the detection ran on (null until known). */
  baseSha: string | null;
  planId: string | null;
  changeId: string | null;
  detection: {
    confidence: "high" | "medium" | "low";
    packageManager: string;
    testRunner: string | null;
    workers: string[];
    uncertain: string[];
    buildScriptsNeedingApproval: string[];
  } | null;
  error: string | null;
  startedAt: string;
}

export interface ImportToolsBackend {
  proposePlatformConfig(
    caller: McpCaller,
    input: { repoId: string; rerun: boolean; waitSec: number },
    opts: MutationOptions,
  ): Promise<ProposalView>;
}

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;

const NextSteps = {
  type: "array",
  description: "What to do next, as concrete tool calls (call) or shell commands (command).",
  items: {
    type: "object",
    properties: { title: str, call: str, command: str, why: str },
    required: ["title"],
  },
} as const;

export const ProposePlatformConfigInput = {
  type: "object",
  properties: {
    repoId: { type: "string", minLength: 1, maxLength: 64 },
    rerun: {
      type: "boolean",
      description:
        "Detect again even if a proposal exists for the current default-branch commit (e.g. after a human rejected it).",
    },
    waitSec: {
      type: "integer",
      minimum: 0,
      maximum: 50,
      description: "How long to wait for the proposal to finish (default 45).",
    },
    idempotencyKey: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Optional. Retrying with the same key returns the first result instead of acting twice.",
    },
  },
  required: ["repoId"],
  additionalProperties: false,
} as const;

export const ProposePlatformConfigOutput = {
  type: "object",
  properties: {
    proposalId: str,
    repoId: str,
    status: { enum: ["running", "proposed", "not-needed", "failed"] },
    baseSha: nullableStr,
    planId: nullableStr,
    changeId: nullableStr,
    detection: {
      type: ["object", "null"],
      properties: {
        confidence: { enum: ["high", "medium", "low"] },
        packageManager: str,
        testRunner: nullableStr,
        workers: { type: "array", items: str },
        uncertain: { type: "array", items: str },
        buildScriptsNeedingApproval: { type: "array", items: str },
      },
      required: [
        "confidence",
        "packageManager",
        "testRunner",
        "workers",
        "uncertain",
        "buildScriptsNeedingApproval",
      ],
    },
    error: nullableStr,
    startedAt: str,
    nextSteps: NextSteps,
  },
  required: [
    "proposalId",
    "repoId",
    "status",
    "baseSha",
    "planId",
    "changeId",
    "detection",
    "error",
    "startedAt",
    "nextSteps",
  ],
} as const;

const Args = z.object({
  repoId: z.string().min(1).max(64),
  rerun: z.boolean().default(false),
  waitSec: z.number().int().min(0).max(50).default(45),
});

const q = (s: string) => JSON.stringify(s);

export function proposalNextSteps(p: ProposalView) {
  if (p.status === "running") {
    return [
      {
        title: "Detection is still running: call again to wait for it",
        call: `propose_platform_config({ repoId: ${q(p.repoId)} })`,
        why: "It runs in a sandbox; the same call returns the finished proposal.",
      },
    ];
  }
  if (p.status === "not-needed") {
    return [
      {
        title: "Nothing to propose: .platform/* and AGENTS.md are already there",
        call: `start_change({ repoId: ${q(p.repoId)}, title: "<what>", category: "fix" })`,
      },
    ];
  }
  if (p.status === "failed") {
    return [
      {
        title: "Detection failed: retry it",
        call: `propose_platform_config({ repoId: ${q(p.repoId)}, rerun: true })`,
        why: "Until a .platform/ci.ts is merged, CI keeps using the detected defaults.",
      },
    ];
  }
  const steps: Array<{ title: string; call?: string; why?: string }> = [
    {
      title: "A human approves the Plan and reviews the Change (Lane 2: it changes .platform/**)",
      why: "You can't approve either; the proposal lists every guess detection made as a risk.",
    },
  ];
  if (p.changeId !== null) {
    steps.push({
      title: "Follow the proposal's CI run and tour",
      call: `wait_for_change({ changeId: ${q(p.changeId)}, until: "tour_ready" })`,
    });
  }
  steps.push({
    title: "Meanwhile, start your own Change (CI uses the detected defaults until this merges)",
    call: `start_change({ repoId: ${q(p.repoId)}, title: "<what>", category: "fix" })`,
  });
  return steps;
}

export function importTools(backend: McpBackend, kit: ToolKit) {
  return [
    defineTool({
      name: "propose_platform_config",
      title: "Propose .platform config for an imported repo",
      description:
        "Detects how an imported repo installs, tests and builds (in a sandbox) and proposes .platform/ci.ts, .platform/policy.ts and AGENTS.md as a draft Plan plus a Change a human approves (never applied silently). Uncertain guesses are listed as risks. Idempotent per default-branch commit; waits up to waitSec.",
      inputSchema: ProposePlatformConfigInput,
      outputSchema: ProposePlatformConfigOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "plan:create");
        kit.requireScope(caller, "change:create");
        const v = kit.parse(Args, {
          repoId: args.repoId,
          rerun: args.rerun,
          waitSec: args.waitSec,
        });
        const p = await kit.run(backend, () =>
          backend.proposePlatformConfig(caller, v, { idempotencyKey: args.idempotencyKey }),
        );
        return { ...p, nextSteps: proposalNextSteps(p) };
      },
    }),
  ] as const;
}
