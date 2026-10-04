/**
 * Running one criterion: its script (with at most one repair when an action can't find its
 * target), or the deterministic smoke check. The verdict here is the runner's own, from what the
 * browser observed: a failed expectation is "fail", an action that still can't act or a script
 * that checked nothing is "couldnt-test", and only expectations that held make a "pass".
 */
import type { QaCriterionResult, QaStepResult, QaVerdict } from "@app/evidence";
import { describeStep, executeStep } from "./execute.js";
import { REPAIR_SYSTEM, repairPrompt } from "./prompts.js";
import {
  type CriterionScript,
  isExpectation,
  ModelRepair,
  REPAIR_JSON_SCHEMA,
  type Step,
} from "./script.js";
import type { ModelSpend } from "./spend.js";
import { traceStep } from "./trace.js";
import type { QaBrowser, QaLimits } from "./types.js";

export interface RunContext {
  browser: QaBrowser;
  spend: ModelSpend;
  limits: QaLimits;
  /** Take a screenshot (null when over the screenshot budget or it failed). */
  shoot(name: string, role: "before" | "step"): Promise<string | undefined>;
  /** Why the run must stop now (time or browser budget), or null. */
  overBudget(): string | null;
}

export interface CriterionRun {
  verdict: QaVerdict;
  reason: string;
  notes?: string[];
  before?: string;
  steps: QaStepResult[];
  consoleErrors: string[];
  networkErrors: string[];
  finalText: string;
}

const record = (s: Step, ok: boolean, detail?: string, shot?: string): QaStepResult => ({
  action: s.action,
  ...(s.target !== undefined ? { target: s.target.slice(0, 500) } : {}),
  ...(s.value !== undefined ? { value: s.value.slice(0, 500) } : {}),
  ok,
  ...(detail !== undefined ? { detail: detail.slice(0, 1000) } : {}),
  ...(shot !== undefined ? { shot } : {}),
});

export async function runScript(
  ctx: RunContext,
  index: number,
  text: string,
  script: CriterionScript,
): Promise<CriterionRun> {
  const b = ctx.browser;
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  const drain = () => {
    const e = b.drainErrors();
    consoleErrors.push(...e.console);
    networkErrors.push(...e.network);
  };
  await b.reset();
  const steps: QaStepResult[] = [];
  const open = await b.goto(script.start);
  const before = await ctx.shoot(`c${index}-before.jpg`, "before");
  drain();
  const notes: string[] = [];
  const done = async (verdict: QaVerdict, reason: string): Promise<CriterionRun> => ({
    verdict,
    reason,
    ...(notes.length > 0 ? { notes: notes.slice(0, 10) } : {}),
    ...(before !== undefined ? { before } : {}),
    steps,
    consoleErrors,
    networkErrors,
    finalText: ((await b.textOf()) ?? "").slice(0, 1500),
  });
  if (!open.ok) {
    steps.push(record({ action: "goto", target: script.start }, false, open.detail));
    const broken = (open.status ?? 0) >= 500;
    return done(
      broken ? "fail" : "couldnt-test",
      `could not open ${script.start}: ${open.detail ?? "no answer"}`,
    );
  }
  let plan = script.steps.slice(0, ctx.limits.maxSteps);
  let repairs = 1;
  let expectations = 0;
  for (let k = 0; k < plan.length; k++) {
    const over = ctx.overBudget();
    if (over !== null)
      return done("couldnt-test", `stopped after ${k} of ${plan.length} steps: ${over}`);
    const s = plan[k] as Step;
    const out = await executeStep(b, s, ctx.limits.stepTimeoutMs);
    const shot = await ctx.shoot(`c${index}-s${steps.length + 1}.jpg`, "step");
    drain();
    // Only expectations that trace to the criterion's own words decide (trace.ts, no model);
    // an untraced one is still run and, when it doesn't hold, becomes an "also observed" note.
    const trace = isExpectation(s) ? traceStep(text, s) : null;
    steps.push({
      ...record(s, out.ok, out.detail, shot),
      ...(trace === null ? {} : { traced: trace.traced }),
    });
    if (out.ok) {
      if (trace?.traced === true) expectations++;
      continue;
    }
    if (trace !== null && !trace.traced) {
      notes.push(
        `also observed: ${describeStep(s)}: ${out.detail ?? "did not hold"} (not counted: ${trace.why ?? "it doesn't trace to the criterion"})`.slice(
          0,
          500,
        ),
      );
      continue;
    }
    // An expectation that could be read and didn't hold is the answer. One whose target names
    // nothing on the page (notFound) couldn't be read: like an action, it gets one repair.
    if (isExpectation(s) && out.notFound !== true)
      return done("fail", `${describeStep(s)}: ${out.detail ?? "did not hold"}`);
    if (out.notFound && repairs > 0 && ctx.spend.available) {
      repairs--;
      const fixed = await ctx.spend.ask({
        purpose: "qa-repair",
        system: REPAIR_SYSTEM,
        user: repairPrompt({
          criterion: text,
          done: steps
            .slice(0, -1)
            .map(
              (r) => `${r.action} ${r.target ?? ""} ${r.value ?? ""} → ${r.ok ? "ok" : "failed"}`,
            ),
          failed: `${describeStep(s)} (${out.detail ?? "not found"})`,
          remaining: JSON.stringify(plan.slice(k + 1)),
          page: await b.snapshot(),
        }),
        schema: ModelRepair,
        jsonSchema: REPAIR_JSON_SCHEMA,
        maxTokens: 1500,
      });
      if (fixed !== null && fixed.giveUp === undefined && fixed.steps.length > 0) {
        plan = [...plan.slice(0, k + 1), ...fixed.steps].slice(0, k + 1 + ctx.limits.maxSteps);
        continue;
      }
      const why = fixed?.giveUp ?? ctx.spend.lastError ?? "no repair";
      return done(
        "couldnt-test",
        `could not ${describeStep(s)}: ${out.detail ?? "not found"} (${why})`,
      );
    }
    return done("couldnt-test", `could not ${describeStep(s)}: ${out.detail ?? "it failed"}`);
  }
  if (expectations === 0)
    return done(
      "couldnt-test",
      "no expectation that traces to the criterion's own words held or ran",
    );
  return done("pass", `${expectations} expectation${expectations === 1 ? "" : "s"} held`);
}

/** No Plan: every route must load (< 400) without uncaught page errors. No model involved. */
export async function runSmoke(
  ctx: RunContext,
  index: number,
  routes: string[],
): Promise<CriterionRun> {
  const b = ctx.browser;
  const steps: QaStepResult[] = [];
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  await b.reset();
  let before: string | undefined;
  const problems: string[] = [];
  for (const route of routes) {
    const over = ctx.overBudget();
    if (over !== null) {
      problems.push(`stopped: ${over}`);
      break;
    }
    const out = await b.goto(route);
    const shot = await ctx.shoot(
      before === undefined ? `c${index}-before.jpg` : `c${index}-s${steps.length + 1}.jpg`,
      before === undefined ? "before" : "step",
    );
    before ??= shot;
    const e = b.drainErrors();
    consoleErrors.push(...e.console);
    networkErrors.push(...e.network);
    const uncaught = e.console.filter((m) => m.startsWith("pageerror:"));
    steps.push(
      record(
        { action: "goto", target: route },
        out.ok && uncaught.length === 0,
        out.ok ? uncaught[0] : out.detail,
        shot,
      ),
    );
    if (!out.ok) problems.push(`${route}: ${out.detail ?? "did not load"}`);
    else if (uncaught.length > 0) problems.push(`${route}: ${uncaught[0]}`);
  }
  const stopped = problems.some((p) => p.startsWith("stopped:"));
  const verdict: QaVerdict =
    problems.length === 0 ? "pass" : stopped && problems.length === 1 ? "couldnt-test" : "fail";
  const reason =
    problems.length === 0
      ? `${routes.length} page${routes.length === 1 ? "" : "s"} loaded without errors`
      : problems.join("; ").slice(0, 2000);
  return {
    verdict,
    reason,
    ...(before !== undefined ? { before } : {}),
    steps,
    consoleErrors,
    networkErrors,
    finalText: ((await b.textOf()) ?? "").slice(0, 1500),
  };
}

export type { QaCriterionResult };
