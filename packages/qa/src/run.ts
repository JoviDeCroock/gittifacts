/**
 * `runQa`: explore the routes, plan a script per criterion (one model call), run each in a fresh
 * page with screenshots, repair at most once, then one model review that may only cast doubt on
 * a pass (pass → couldn't test): "fail" always comes from a failed expectation in the browser.
 * Returns the `qa-run` evidence item; the caller signs it.
 */
import type { QaArtifact, QaCriterionResult, QaRun } from "@app/evidence";
import { type CriterionRun, type RunContext, runScript, runSmoke } from "./criterion.js";
import { describeStep } from "./execute.js";
import { PLAN_SYSTEM, PROMPT_VERSION, planPrompt, REVIEW_SYSTEM, reviewPrompt } from "./prompts.js";
import { worse } from "./routes.js";
import {
  type CriterionScript,
  ModelPlan,
  ModelReview,
  PLAN_JSON_SCHEMA,
  REVIEW_JSON_SCHEMA,
} from "./script.js";
import { ModelSpend } from "./spend.js";
import { DEFAULT_LIMITS, type PageSnapshot, type QaDeps, type QaRunInput } from "./types.js";

const MAX_FRAMES = 30;
const THUMBS = 4;

export async function runQa(input: QaRunInput, deps: QaDeps): Promise<QaRun> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const started = deps.now();
  const b = deps.browser;
  const spend = new ModelSpend(deps.llm, limits.llmUsd, deps.metadata);
  const artifacts: QaArtifact[] = [];
  const frames: Uint8Array[] = [];
  let shots = 0;
  const log = deps.log ?? (() => undefined);

  const overBudget = (): string | null => {
    if (deps.now() - started > limits.wallMs)
      return `over the run's time budget (${Math.round(limits.wallMs / 1000)} s)`;
    if (b.usedMs() > limits.browserMs)
      return `over the run's browser budget (${Math.round(limits.browserMs / 1000)} s)`;
    return null;
  };
  const ctx: RunContext = {
    browser: b,
    spend,
    limits,
    overBudget,
    shoot: async (name, role) => {
      if (shots >= limits.maxScreenshots) return undefined;
      const bytes = await b.screenshot().catch(() => null);
      if (bytes === null) return undefined;
      shots++;
      if (frames.length < MAX_FRAMES) frames.push(bytes);
      artifacts.push(await deps.artifacts.put(name, bytes, "image/jpeg", role));
      return name;
    },
  };

  const selected = input.criteria.slice(0, limits.maxCriteria).map((c, index) => ({ ...c, index }));
  const overflow = input.criteria
    .slice(limits.maxCriteria)
    .map((c, i) => ({ ...c, index: limits.maxCriteria + i }));
  const routes = input.routes.length > 0 ? input.routes : ["/"];

  // 1. Explore: what the browser sees on each route (the planner only uses what is there).
  const pages: PageSnapshot[] = [];
  const planned = selected.filter((c) => c.source === "plan");
  if (planned.length > 0) {
    for (const route of routes) {
      if (overBudget() !== null) break;
      const out = await b.goto(route);
      if (out.ok) pages.push(await b.snapshot());
      b.drainErrors();
    }
  }
  log("qa.explored", { routes: routes.length, pages: pages.length });

  // 2. Plan: one model call for every Plan criterion.
  const scripts = new Map<number, CriterionScript>();
  let planProblem: string | null = null;
  if (planned.length > 0) {
    const plan =
      pages.length === 0
        ? null
        : await spend.ask({
            purpose: "qa-plan",
            system: PLAN_SYSTEM,
            user: planPrompt({ criteria: planned, pages, changedFiles: input.changedFiles }),
            schema: ModelPlan,
            jsonSchema: PLAN_JSON_SCHEMA,
            maxTokens: 4000,
          });
    if (plan === null)
      planProblem =
        pages.length === 0 ? "no page of the app could be opened" : (spend.lastError ?? "no plan");
    for (const s of plan?.criteria ?? [])
      if (planned.some((c) => c.index === s.index) && !scripts.has(s.index))
        scripts.set(s.index, s);
  }
  log("qa.planned", { scripts: scripts.size, problem: planProblem });

  // 3. Run each criterion.
  const runs = new Map<number, CriterionRun>();
  const thumbs: string[] = [];
  for (const c of selected) {
    const over = overBudget();
    const script = scripts.get(c.index);
    let run: CriterionRun;
    if (over !== null) run = stub("couldnt-test", over);
    else if (c.source === "smoke") run = await runSmoke(ctx, c.index, routes);
    else if (script === undefined)
      run = stub(
        "couldnt-test",
        `no script: ${planProblem ?? "the model gave none for this criterion"}`,
      );
    else if (script.untestable !== undefined)
      run = stub("couldnt-test", `not testable in a browser: ${script.untestable}`);
    else run = await runScript(ctx, c.index, c.text, script);
    runs.set(c.index, run);
    if (run.steps.length > 0 && thumbs.length < THUMBS) {
      const thumb = await b.screenshot({ thumb: true }).catch(() => null);
      if (thumb !== null) {
        const name = `c${c.index}-thumb.jpg`;
        artifacts.push(await deps.artifacts.put(name, thumb, "image/jpeg", "thumb"));
        thumbs.push(name);
      }
    }
    log("qa.criterion", { index: c.index, verdict: run.verdict, steps: run.steps.length });
  }

  // 4. Review: a second opinion that may only move a verdict down.
  const reviewed = [...runs.entries()].filter(([, r]) => r.steps.length > 0);
  if (reviewed.length > 0 && spend.available && planned.length > 0) {
    const review = await spend.ask({
      purpose: "qa-review",
      system: REVIEW_SYSTEM,
      user: reviewPrompt(
        reviewed.map(([index, r]) => ({
          index,
          text: selected.find((c) => c.index === index)?.text ?? "",
          steps: r.steps.map(
            (s) =>
              `${describeStep(s)} → ${s.ok ? "ok" : "FAILED"}${s.detail ? ` (${s.detail})` : ""}`,
          ),
          finalText: r.finalText,
          errors: [...r.consoleErrors, ...r.networkErrors].slice(0, 10),
          verdict: r.verdict,
        })),
      ),
      schema: ModelReview,
      jsonSchema: REVIEW_JSON_SCHEMA,
      maxTokens: 2000,
    });
    for (const v of review?.verdicts ?? []) {
      const r = runs.get(v.index);
      if (r === undefined || r.steps.length === 0) continue;
      // The browser's evidence decides "fail" (a failed expectation); the review can only cast
      // doubt on a pass (→ couldn't test). Seen live: a review failed a criterion that held
      // because of another criterion's bug.
      const next = worse(r.verdict, v.verdict === "fail" ? "couldnt-test" : v.verdict);
      if (next !== r.verdict)
        runs.set(v.index, {
          ...r,
          verdict: next,
          reason: `${r.reason}; review: ${v.reason}`.slice(0, 2000),
        });
    }
  }

  // 5. Replay: the step screenshots as one GIF, encoded in the browser.
  if (frames.length >= 2 && b.replayGif !== undefined && overBudget() === null) {
    const gif = await b.replayGif(frames, { width: 640, delayMs: 900 }).catch(() => null);
    if (gif !== null)
      artifacts.push(await deps.artifacts.put("replay.gif", gif, "image/gif", "recording"));
  }

  const criteria: QaCriterionResult[] = [
    ...selected.map((c) => result(c, runs.get(c.index) ?? stub("couldnt-test", "not run"))),
    ...overflow.map((c) =>
      result(c, stub("couldnt-test", `over the run's limit of ${limits.maxCriteria} criteria`)),
    ),
  ];
  return {
    id: "qa-run",
    kind: "qa-run",
    status: "ok",
    runId: input.runId,
    trigger: input.trigger,
    requestedBy: input.requestedBy,
    app: { source: "private-preview", snapshotStep: input.snapshotStep, origin: input.origin },
    model: spend.model,
    promptVersion: PROMPT_VERSION,
    criteria,
    artifacts,
    blockedOrigins: b.blockedOrigins().slice(0, 50),
    usage: {
      wallMs: Math.max(0, Math.round(deps.now() - started)),
      browserMs: Math.max(0, Math.round(b.usedMs())),
      llmCalls: spend.calls,
      inputTokens: spend.inputTokens,
      outputTokens: spend.outputTokens,
      llmUsd: Math.round(spend.usd * 1e6) / 1e6,
    },
  };
}

function stub(verdict: CriterionRun["verdict"], reason: string): CriterionRun {
  return { verdict, reason, steps: [], consoleErrors: [], networkErrors: [], finalText: "" };
}

function result(
  c: { index: number; text: string; source: "plan" | "smoke" },
  r: CriterionRun,
): QaCriterionResult {
  return {
    index: c.index,
    text: c.text.slice(0, 1000),
    source: c.source,
    verdict: r.verdict,
    reason: r.reason.slice(0, 2000),
    ...(r.before !== undefined ? { before: r.before } : {}),
    steps: r.steps.slice(0, 30),
    consoleErrors: r.consoleErrors.length,
    networkErrors: r.networkErrors.length,
  };
}
