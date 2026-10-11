/**
 * `compare_attempts`: several agents may attempt the same approved Plan, each its own Change. This
 * ranks them by evidence and lane (@app/domain `rankAttempts`: pure, unknown ranks below measured)
 * and says which one is recommended. It decides nothing: a person picks one on the plan's page,
 * which approves it and closes the others as superseded.
 */
import { type AttemptsRanking, Id } from "@app/domain";
import { defineTool } from "mcp-tada-server";
import { z } from "zod";
import type { McpBackend, McpCaller } from "../backend.js";
import type { ToolKit } from "./workspace.js";

// ---------------------------------------------------------------- backend contract

/** The ranking plus which attempt a person picked (null: none yet). */
export type AttemptsData = AttemptsRanking & {
  planId: string;
  picked: { changeId: string; by: { id: string; name: string }; at: string } | null;
};

export interface AttemptToolsBackend {
  /** Every Change on the plan, ranked (read access to the plan's repo). */
  compareAttempts(caller: McpCaller, planId: string): Promise<AttemptsData>;
}

// ---------------------------------------------------------------- schemas

const str = { type: "string" } as const;

const Attempt = {
  type: "object",
  properties: {
    rank: { type: "integer", description: "1 is best." },
    changeId: str,
    title: str,
    status: str,
    standing: {
      enum: ["finished", "grading", "closed"],
      description: "finished: graded; grading: CI, evidence or the lane still running; closed.",
    },
    green: { type: "boolean", description: "CI passed and no test fails." },
    lane: { type: ["integer", "null"] },
    author: {
      type: "object",
      properties: { id: str, name: str, kind: str },
      required: ["id", "name", "kind"],
    },
    reasons: {
      type: "array",
      items: str,
      description:
        'Why it ranks here, in words: "Lane 1", "tests pass (12)", "scope drift", "42 lines".',
    },
    diffLines: { type: ["integer", "null"] },
    recommended: { type: "boolean" },
    pickable: {
      type: "boolean",
      description: "A person can pick it now (awaiting review or approved).",
    },
    url: { type: "string", description: "The change's page." },
  },
  required: [
    "rank",
    "changeId",
    "title",
    "status",
    "standing",
    "green",
    "lane",
    "author",
    "reasons",
    "diffLines",
    "recommended",
    "pickable",
    "url",
  ],
} as const;

const CompareAttemptsInput = {
  type: "object",
  properties: { planId: { type: "string", minLength: 1, maxLength: 64, description: "The plan." } },
  required: ["planId"],
  additionalProperties: false,
} as const;

const CompareAttemptsOutput = {
  type: "object",
  properties: {
    planId: str,
    summary: { type: "string", description: '"3 attempts: 2 finished, 1 still grading".' },
    attempts: { type: "array", items: Attempt, description: "Best first." },
    recommended: {
      type: ["object", "null"],
      properties: {
        changeId: str,
        provisional: { type: "boolean", description: "Nothing finished grading: it leads so far." },
        why: str,
      },
      required: ["changeId", "provisional", "why"],
    },
    picked: {
      type: ["object", "null"],
      description: "The attempt a person picked (it was approved; the others were closed).",
      properties: {
        changeId: str,
        by: { type: "object", properties: { id: str, name: str }, required: ["id", "name"] },
        at: str,
      },
      required: ["changeId", "by", "at"],
    },
    url: { type: "string", description: "The plan's page, where a person picks an attempt." },
    nextSteps: {
      type: "array",
      items: {
        type: "object",
        properties: { title: str, call: str, why: str },
        required: ["title"],
      },
    },
  },
  required: ["planId", "summary", "attempts", "recommended", "picked", "url", "nextSteps"],
} as const;

const CompareAttemptsArgs = z.object({ planId: Id });

type Step = { title: string; call?: string; why?: string };

/** What the calling agent does next, depending on where its own attempt stands. */
function attemptSteps(data: AttemptsData, caller: McpCaller, planUrl: string | null): Step[] {
  const mine = data.attempts.find((a) => a.author.id === caller.principalId);
  if (data.picked !== null) {
    if (mine === undefined) return [];
    return data.picked.changeId === mine.changeId
      ? [
          {
            title:
              "A person picked your attempt and approved it: the merge queue lands it; wait for the merge",
            call: `wait_for_merge({ changeId: "${mine.changeId}" })`,
          },
        ]
      : [
          {
            title: "A person picked another attempt; yours was closed as superseded",
            why: `Picked: ${data.picked.changeId}. Nothing more to do on this plan.`,
          },
        ];
  }
  if (mine === undefined) return [];
  if (mine.standing === "grading") {
    return [
      {
        title: "Your attempt is still grading",
        call: `wait_for_change({ changeId: "${mine.changeId}", until: "tour_ready" })`,
      },
    ];
  }
  return [
    {
      title: mine.recommended
        ? "Your attempt ranks first: ask a person to pick it"
        : `Your attempt ranks ${mine.rank} of ${data.attempts.length}`,
      why: `A person picks one on the plan's page${planUrl === null ? "" : ` (${planUrl})`}; the others are closed.`,
      call: `request_review({ changeId: "${mine.changeId}" })`,
    },
  ];
}

export function attemptTools(backend: McpBackend, kit: ToolKit) {
  return [
    defineTool({
      name: "compare_attempts",
      title: "Compare attempts at a plan",
      description:
        "Several agents may attempt the same approved plan, each its own change. This ranks every change on the plan by evidence and lane (lane, CI, tests, red/green proof, scope drift, coverage, mutation, public API, diff size, time to green; anything not measured ranks below measured) and says which one is recommended. A person picks one on the plan's page (url): that approves it and closes the others as superseded. Read-only.",
      inputSchema: CompareAttemptsInput,
      outputSchema: CompareAttemptsOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args, ctx) => {
        const caller = kit.callerOf(ctx);
        kit.requireScope(caller, "repo:read");
        const { planId } = kit.parse(CompareAttemptsArgs, args);
        const data = await kit.run(backend, () => backend.compareAttempts(caller, planId));
        const url = backend.webUrl({ planId });
        return {
          planId: data.planId,
          summary: data.summary,
          attempts: data.attempts.map((a) => ({
            rank: a.rank,
            changeId: a.changeId,
            title: a.title,
            status: a.status,
            standing: a.standing,
            green: a.green,
            lane: a.lane,
            author: a.author,
            reasons: a.reasons,
            diffLines: a.diff?.lines ?? null,
            recommended: a.recommended,
            pickable: a.pickable,
            url: backend.webUrl({ changeId: a.changeId }),
          })),
          recommended: data.recommended,
          picked: data.picked,
          url,
          nextSteps: attemptSteps(data, caller, url),
        };
      },
    }),
  ];
}
