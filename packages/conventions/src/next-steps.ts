/**
 * `nextSteps` for create/mutate responses and lifecycle events, so an agent never has to guess
 * what to do next. Every step carries a concrete `call` (MCP) or `command` (shell).
 */
import type { Lane, NextStep } from "@app/domain";
import { call } from "./calls.js";

/**
 * The first thing an agent must do after `create_project` without credentials: its MCP session is
 * still anonymous, so every later call fails with 401 until it reconnects with the project token
 * (onboarding eval m-20261002-073146-qzvw). Also in the tool's description (@app/mcp).
 */
export const ANONYMOUS_RECONNECT =
  "Reconnect with `Authorization: Bearer <token>` (the `token` field in this response). Every other tool needs it, and this repo's tools are unavailable without it.";

/** The same rule, said before the call (/start, /llms.txt). */
export const ANONYMOUS_RECONNECT_BEFORE =
  "After create_project without credentials, reconnect with `Authorization: Bearer <token>` (the `token` field in its response): every other tool needs it, and the repo's tools are unavailable without it.";

const PUSH = (remote: { url: string; branch: string }) =>
  `git -c http.extraHeader="Authorization: Bearer <remote.token>" push ${remote.url} HEAD:${remote.branch}`;

export interface NextStepContexts {
  project_created: {
    projectId: string;
    /** The Change running the first CI + preview, if create_project started one. */
    changeId?: string | undefined;
    /** The Change create_project opened for the caller, and its fork (push there right away). */
    firstChange?: { changeId: string; remote: { url: string; branch: string } } | undefined;
    remoteUrl?: string | undefined;
    previewUrl?: string | null | undefined;
    claimUrl?: string | null | undefined;
    claimed: boolean;
    /** Unclaimed projects: when the platform deletes it unless a human claims it (ISO). */
    expiresAt?: string | null | undefined;
    /**
     * Set when create_project ran without credentials: the response carries the project's token
     * and the caller's session is still anonymous. The first step is to reconnect with it.
     */
    anonymous?: { mcpUrl: string } | undefined;
    /**
     * Imported from a git URL: the repo has no `.platform/*` of its own, so the next move is to
     * let detection propose one (a Plan + Change a human approves).
     */
    imported?: boolean | undefined;
    /**
     * Template repos: the sample Plan create_project drafted (author: the platform). The steps then
     * lead down the golden path: a human approves it, you build it, a human reviews, it merges.
     */
    samplePlan?: { planId: string; title: string; url: string } | undefined;
  };
  change_started: { changeId: string; remote: { url: string; branch: string } };
  push_received: { changeId: string; headSha?: string | undefined };
  ci_failed: {
    changeId: string;
    /** The failing pipeline step, e.g. "test". */
    step: string;
    /** Last meaningful log line(s), if known. */
    logTail?: string | undefined;
    /** Local command reproducing the step (from the pipeline spec). */
    command?: string | undefined;
  };
  evidence_ready: { changeId: string; ciPassed: boolean };
  lane_assigned: {
    changeId: string;
    lane: Lane;
    /** Whether the repo has left shadow mode (and is claimed). */
    lane0Enabled: boolean;
    reasons?: readonly { code: string; lane: Lane; message: string }[] | undefined;
  };
  tour_ready: { changeId: string; lane: Lane };
  merged: { changeId: string; repoId: string; rollout: boolean };
  reverted: {
    changeId: string;
    repoId: string;
    revertChangeId?: string | undefined;
    reason?: string | undefined;
  };
}
export type NextStepEvent = keyof NextStepContexts;
export const NEXT_STEP_EVENTS = [
  "project_created",
  "change_started",
  "push_received",
  "ci_failed",
  "evidence_ready",
  "lane_assigned",
  "tour_ready",
  "merged",
  "reverted",
] as const satisfies readonly NextStepEvent[];

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Step names the default pipelines use, with what usually fixes them. */
export function ciFailureHint(step: string, logTail = ""): string {
  if (step === "install") {
    if (/OUTDATED_LOCKFILE|frozen-lockfile|lockfile.*(not up to date|out of date)/i.test(logTail)) {
      return "The lockfile doesn't match package.json: run the install without --frozen-lockfile locally and commit the lockfile.";
    }
    return "Dependencies failed to install: check package names and versions; unclaimed repos can only reach package registries.";
  }
  if (step === "lint") return "Lint failed: run the lint command locally and fix what it reports.";
  if (step === "typecheck")
    return "Type errors: run the typecheck command locally; fix the first error first.";
  if (step === "test")
    return "Tests failed: the log names the failing tests; run that file locally, fix the code (or the test if it is wrong).";
  if (step === "build")
    return "The build failed: run the build command locally; it must write the build output directory.";
  if (step.startsWith("evidence:"))
    return "A platform evidence step errored: this raises the lane but is not your bug. Read the log; push again if it looks transient.";
  return `Step "${step}" failed: run its command locally and fix what it reports.`;
}

const LOCAL_COMMANDS: Record<string, string> = {
  install: "pnpm install",
  lint: "pnpm run lint",
  typecheck: "pnpm run typecheck",
  test: "pnpm run test",
  build: "pnpm run build",
};

function laneSteps(c: NextStepContexts["lane_assigned"]): NextStep[] {
  const { changeId } = c;
  const raised = (c.reasons ?? []).filter((r) => r.lane >= Math.max(c.lane, 1));
  const why =
    raised.length === 0
      ? undefined
      : clip(`Raised by: ${raised.map((r) => r.code).join(", ")}.`, 600);
  if (c.lane === 0 && c.lane0Enabled) {
    return [
      {
        title: "Auto-merge (Lane 0): the merge queue merges it without a human",
        why: "Every item on the auto-merge checklist passed.",
        call: call("wait_for_change", { changeId, until: "merged", timeoutSec: 50 }),
      },
    ];
  }
  const review = [
    {
      title: "Wait for the reviewer's walkthrough",
      call: call("wait_for_change", { changeId, until: "tour_ready", timeoutSec: 50 }),
    },
    {
      title: "Ask a human to review it (you can't approve)",
      call: call("request_review", { changeId }),
    },
    {
      title: "Wait until it merges",
      call: call("wait_for_change", { changeId, until: "merged", timeoutSec: 50 }),
    },
  ];
  if (c.lane === 0) {
    return [
      {
        title: "Auto-merge is calibrating: a human still gives it a quick review (handled like Lane 1)",
        why: "Auto-merge is off until the repo owner turns it on after enough agreement (unclaimed repos: always off). Your Change still counts towards that agreement.",
        call: call("wait_for_change", { changeId, until: "tour_ready", timeoutSec: 50 }),
      },
      ...review.slice(1),
    ];
  }
  if (c.lane === 1) {
    return [
      {
        ...review[0]!,
        title: "Quick review (Lane 1): wait for the walkthrough",
        ...(why === undefined ? {} : { why }),
      },
      ...review.slice(1),
    ];
  }
  return [
    {
      title: "Full review (Lane 2): read why, and lower it if you can",
      why: why ?? "A human reviews the walkthrough and the diff.",
      call: call("get_change_status", { changeId }),
    },
    {
      title: "Optional: split the Change or add the missing evidence, then push again",
      why: "Smaller diffs, red/green proof for fixes, no new dependencies and no sensitive paths keep lanes low.",
      command: PUSH({ url: "<remote.url>", branch: "<remote.branch>" }),
    },
    ...review,
  ];
}

/**
 * `wait_for_change` returns within `timeoutSec` (≤ 50 s by default, under the MCP SDK's 60 s
 * client request timeout); agents call it again while `reason` is "timeout".
 */
export const WAIT_TIMEOUT_SEC = 50;
export const WAIT_AGAIN = `Returns within ${WAIT_TIMEOUT_SEC} s; call it again while reason is "timeout".`;

function claimStep(c: NextStepContexts["project_created"]): NextStep {
  return {
    title: "Give the claim link to a human to keep this repo",
    why: clip(
      `${c.claimUrl ? `Claim link: ${c.claimUrl}. ` : "The claimUrl is in the create_project response. "}` +
        `${c.expiresAt ? `Unless a human claims it, this repo is deleted at ${c.expiresAt}. ` : "Unclaimed repos expire unless a human claims them. "}` +
        "Until then: previews only, no secrets, no production deploys, no auto-merge, tight quotas. " +
        "The response's token is your Bearer token for this repo only: send it as Authorization on every call. whoami shows the expiry and quotas.",
      600,
    ),
    call: call("whoami", {}),
  };
}

/**
 * The golden path of a template repo (DECISIONS 2026-10-11): claim (if unclaimed) → a human
 * approves the sample Plan → you build it on a Change → lane → a human reviews → it merges.
 */
function goldenPath(
  c: NextStepContexts["project_created"],
  plan: NonNullable<NextStepContexts["project_created"]["samplePlan"]>,
): NextStep[] {
  const changeId = "<changeId from start_change>";
  return [
    ...(c.claimed ? [] : [claimStep(c)]),
    {
      title: clip(`Ask a human to approve the sample plan "${plan.title}"`, 200),
      why: clip(
        `The platform drafted it; you can't approve it. Send the human ${plan.url}${c.claimed ? "" : " (after they claim the repo)"}. Check its status with get_plan.`,
        600,
      ),
      call: call("get_plan", { planId: plan.planId }),
    },
    {
      title: "Build it: start a Change on the plan",
      why: "Its acceptance criteria are what the evidence and the reviewer check.",
      call: call("start_change", {
        repoId: c.projectId,
        planId: plan.planId,
        title: plan.title,
        category: "feature",
      }),
    },
    {
      title: "Commit the work (code and test) and push it to the Change's fork",
      command: PUSH({ url: "<remote.url>", branch: "<remote.branch>" }),
    },
    {
      title: "Wait for the lane (CI, signed evidence, then the review lane)",
      call: call("wait_for_change", { changeId, until: "lane_assigned", timeoutSec: 50 }),
    },
    {
      title: "Ask a human to review it (you can't approve)",
      call: call("request_review", { changeId }),
    },
    {
      title: "Wait until the merge queue lands it",
      call: call("wait_for_change", { changeId, until: "merged", timeoutSec: 50 }),
    },
  ];
}

/** Every wait step says to call again on timeout. */
function withWaitHint(step: NextStep): NextStep {
  if (step.call === undefined || !step.call.startsWith("wait_for_change(")) return step;
  if (step.why?.includes(WAIT_AGAIN)) return step;
  return {
    ...step,
    why: clip(step.why === undefined ? WAIT_AGAIN : `${step.why} ${WAIT_AGAIN}`, 600),
  };
}

export function nextStepsFor<E extends NextStepEvent>(
  event: E,
  ctx: NextStepContexts[E],
): NextStep[] {
  return stepsFor(event, ctx).map(withWaitHint);
}

function stepsFor<E extends NextStepEvent>(event: E, ctx: NextStepContexts[E]): NextStep[] {
  switch (event) {
    case "project_created": {
      const c = ctx as NextStepContexts["project_created"];
      const steps: NextStep[] = [];
      if (c.anonymous !== undefined) {
        steps.push({
          title: clip(`Reconnect to ${c.anonymous.mcpUrl} with Authorization: Bearer <token>`, 200),
          why: clip(
            `${ANONYMOUS_RECONNECT} MCP server: ${c.anonymous.mcpUrl}. Then call whoami: it lists this repo.`,
            600,
          ),
          call: call("whoami", {}),
        });
      }
      if (c.samplePlan !== undefined) steps.push(...goldenPath(c, c.samplePlan));
      if (c.changeId !== undefined) {
        steps.push({
          title: "Wait for the first CI run and preview",
          why: "create_project returns at once; CI and the preview finish in the background.",
          call: call("wait_for_change", {
            changeId: c.changeId,
            until: "evidence_ready",
            timeoutSec: 50,
          }),
        });
      }
      if (c.imported === true) {
        steps.push({
          title: "Let detection propose this repo's .platform/ci.ts, policy.ts and AGENTS.md",
          why: "Detection reads the repo in a sandbox and proposes them as a Plan + Change a human approves (full review, Lane 2: it changes .platform/**). Until it merges, CI runs the detected defaults. Returns within waitSec; call it again to follow the same proposal.",
          call: call("propose_platform_config", { repoId: c.projectId, waitSec: 45 }),
        });
      }
      if (c.previewUrl)
        steps.push({ title: "Open the preview", command: `curl -s ${c.previewUrl}` });
      if (c.firstChange !== undefined) {
        const f = c.firstChange;
        steps.push(
          {
            title: "Clone your first Change's fork (it starts at the initial commit)",
            why: "remote.token is a push token for this fork only; main is written by the merge queue.",
            command: `git -c http.extraHeader="Authorization: Bearer <remote.token>" clone ${f.remote.url}`,
          },
          {
            title: "Commit your work and push it to the fork",
            why: "CI, signed evidence, a lane and a preview of your head follow automatically.",
            command: PUSH(f.remote),
          },
          {
            title: "Wait for your Change's evidence",
            call: call("wait_for_change", {
              changeId: f.changeId,
              until: "evidence_ready",
              timeoutSec: 50,
            }),
          },
        );
      } else if (c.remoteUrl !== undefined) {
        steps.push({
          title: "Clone the repo (read it; push only to a Change's fork)",
          command: `git -c http.extraHeader="Authorization: Bearer <token>" clone ${c.remoteUrl}`,
        });
      }
      steps.push({
        title: "Plan your first change (a human approves Plans)",
        call: call("create_plan", {
          repoId: c.projectId,
          title: "<what>",
          intent: "<why>",
          acceptanceCriteria: ["<observable result>"],
          scopePaths: ["src/**", "test/**"],
        }),
      });
      steps.push({
        title: "Or start a Change right away (it can't auto-merge without an approved Plan)",
        call: call("start_change", { repoId: c.projectId, title: "<what>", category: "feature" }),
      });
      // The golden path puts the claim first (nobody approves in an unclaimed repo).
      if (!c.claimed && c.samplePlan === undefined) steps.push(claimStep(c));
      return steps;
    }
    case "change_started": {
      const c = ctx as NextStepContexts["change_started"];
      return [
        {
          title: "Commit your work and push it to the Change's fork",
          why: "Never push to main; this remote only accepts this Change.",
          command: PUSH(c.remote),
        },
        {
          title: "Wait for CI and evidence",
          call: call("wait_for_change", {
            changeId: c.changeId,
            until: "evidence_ready",
            timeoutSec: 50,
          }),
        },
      ];
    }
    case "push_received": {
      const c = ctx as NextStepContexts["push_received"];
      return [
        {
          title: `Pipeline started${c.headSha === undefined ? "" : ` for ${c.headSha.slice(0, 12)}`}: wait for evidence`,
          why: "An older run for this Change is superseded.",
          call: call("wait_for_change", {
            changeId: c.changeId,
            until: "evidence_ready",
            timeoutSec: 50,
          }),
        },
      ];
    }
    case "ci_failed": {
      const c = ctx as NextStepContexts["ci_failed"];
      const hint = ciFailureHint(c.step, c.logTail);
      const tail =
        c.logTail === undefined
          ? ""
          : ` Log: ${c.logTail.trim().split("\n").slice(-3).join(" | ")}`;
      return [
        {
          title: `Read the "${c.step}" step log`,
          why: clip(`${hint}${tail}`, 600),
          call: call("get_change_status", { changeId: c.changeId }),
        },
        {
          title: `Reproduce "${c.step}" locally`,
          command: c.command ?? LOCAL_COMMANDS[c.step] ?? "pnpm run test",
        },
        {
          title: "Push the fix and wait again",
          call: call("wait_for_change", {
            changeId: c.changeId,
            until: "evidence_ready",
            timeoutSec: 50,
          }),
        },
      ];
    }
    case "evidence_ready": {
      const c = ctx as NextStepContexts["evidence_ready"];
      if (!c.ciPassed) {
        return [
          {
            title: "CI failed: find the failing step",
            call: call("get_change_status", { changeId: c.changeId }),
          },
          {
            title: "Fix it, push again and wait",
            call: call("wait_for_change", {
              changeId: c.changeId,
              until: "evidence_ready",
              timeoutSec: 50,
            }),
          },
        ];
      }
      return [
        {
          title: "CI is green: wait for the lane",
          call: call("wait_for_change", {
            changeId: c.changeId,
            until: "lane_assigned",
            timeoutSec: 50,
          }),
        },
        {
          title: "Inspect the signed evidence",
          call: call("get_evidence", { changeId: c.changeId }),
        },
      ];
    }
    case "lane_assigned":
      return laneSteps(ctx as NextStepContexts["lane_assigned"]);
    case "tour_ready": {
      const c = ctx as NextStepContexts["tour_ready"];
      return [
        {
          title: "Read the walkthrough; unproven stops are what a reviewer will question",
          call: call("get_tour", { changeId: c.changeId }),
        },
        {
          title: "Ask a human to review it",
          call: call("request_review", { changeId: c.changeId }),
        },
        {
          title: "Wait until it merges",
          call: call("wait_for_change", {
            changeId: c.changeId,
            until: "merged",
            timeoutSec: 50,
          }),
        },
      ];
    }
    case "merged": {
      const c = ctx as NextStepContexts["merged"];
      const steps: NextStep[] = [];
      if (c.rollout) {
        steps.push({
          title: "Check the rollout; regressions are rolled back and reverted automatically",
          call: call("get_change_status", { changeId: c.changeId }),
        });
      }
      steps.push({
        title: "Start the next change from a fresh Plan",
        call: call("create_plan", {
          repoId: c.repoId,
          title: "<what>",
          intent: "<why>",
          acceptanceCriteria: ["<observable result>"],
        }),
      });
      return steps;
    }
    case "reverted": {
      const c = ctx as NextStepContexts["reverted"];
      return [
        {
          title: "See which production errors triggered the revert",
          why: c.reason === undefined ? undefined : clip(c.reason, 600),
          call: call("list_issues_for_change", { changeId: c.changeId }),
        },
        ...(c.revertChangeId === undefined
          ? []
          : [
              {
                title: "Follow the revert Change",
                call: call("get_change_status", { changeId: c.revertChangeId }),
              },
            ]),
        {
          title: "Fix forward in a new Change with a regression test",
          why: 'Claim category "fix": the new test must fail on base and pass on head.',
          call: call("start_change", {
            repoId: c.repoId,
            title: "<fix for the reverted change>",
            category: "fix",
          }),
        },
      ].map(dropUndefined);
    }
  }
  return [];
}

function dropUndefined(step: NextStep): NextStep {
  return Object.fromEntries(Object.entries(step).filter(([, v]) => v !== undefined)) as NextStep;
}
