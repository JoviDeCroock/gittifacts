/**
 * LLM judgments: scope-drift, plan-conformance, hidden-behavior-change. Raise-only signals for the
 * classifier ("unsure" → Lane 1, "concern" → Lane 2, "no-concern" changes nothing).
 *
 * Anything that goes wrong becomes "unsure" (or status "error" when the call itself failed), never
 * "no-concern". One call answers every question; there is no regeneration.
 */
import type { ChangeDiff, Plan } from "@app/domain";
import { LlmJudgment } from "@app/evidence";
import {
  affordableInputTokens,
  BudgetTracker,
  estimateCallCostUsd,
  estimateTokens,
  type PriceTable,
  type ReviewerBudget,
} from "./budget.js";
import { renderDiff } from "./diff.js";
import { type LlmClient, LlmError, type LlmResponse, parseJsonLoose } from "./llm.js";
import { buildJudgeUserPrompt, JUDGE_SYSTEM_PROMPT, PROMPT_VERSION } from "./prompt.js";
import { hasRisk, rankHunks } from "./rank.js";
import {
  JUDGE_JSON_SCHEMA,
  JUDGE_QUESTIONS,
  type JudgeOutcome,
  type JudgeQuestion,
  ModelJudgment,
} from "./schema.js";

export interface JudgeInput {
  plan: Plan | null;
  diff: ChangeDiff;
  budget: ReviewerBudget;
}

export interface CallRecord {
  purpose: "tour" | "judge";
  attempt: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  logId?: string;
}

export interface JudgeResult {
  items: LlmJudgment[];
  costUsd: number;
  budgetExceeded: boolean;
  calls: CallRecord[];
}

export interface JudgeDeps {
  client: LlmClient;
  prices: PriceTable;
  maxOutputTokens: number;
  diffTokenBudget: number;
}

const SEVERITY: Record<JudgeOutcome, number> = { "no-concern": 0, unsure: 1, concern: 2 };
const MIN_JUDGE_DIFF_TOKENS = 500;

export function judgmentId(question: JudgeQuestion): string {
  return `llm-judgment:${question}`;
}

function clip(text: string, max: number): string {
  const s = text.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function item(
  question: JudgeQuestion,
  outcome: JudgeOutcome,
  rationale: string,
  model: string,
  status: "ok" | "error" | "skipped" = "ok",
  note?: string,
): LlmJudgment {
  return LlmJudgment.parse({
    id: judgmentId(question),
    kind: "llm-judgment",
    status,
    question,
    outcome,
    rationale: clip(rationale, 4000),
    model,
    ...(note === undefined ? {} : { note: clip(note, 4000) }),
  });
}

/**
 * Read the model's answer leniently: valid entries are kept even when others are malformed, the
 * most severe answer wins for a repeated question, and unanswered questions become "unsure".
 */
export function parseJudgments(
  response: Pick<LlmResponse, "text" | "json">,
  questions: readonly JudgeQuestion[],
): Map<JudgeQuestion, { outcome: JudgeOutcome; rationale: string }> {
  const out = new Map<JudgeQuestion, { outcome: JudgeOutcome; rationale: string }>();
  const json = response.json ?? parseJsonLoose(response.text);
  const raw =
    json !== null &&
    typeof json === "object" &&
    "judgments" in json &&
    Array.isArray(json.judgments)
      ? (json.judgments as unknown[])
      : Array.isArray(json)
        ? (json as unknown[])
        : [];
  for (const entry of raw) {
    const r = ModelJudgment.safeParse(entry);
    if (!r.success || !questions.includes(r.data.question)) continue;
    const prev = out.get(r.data.question);
    if (prev === undefined || SEVERITY[r.data.outcome] > SEVERITY[prev.outcome]) {
      out.set(r.data.question, { outcome: r.data.outcome, rationale: r.data.rationale });
    }
  }
  for (const q of questions) {
    if (!out.has(q)) {
      out.set(q, {
        outcome: "unsure",
        rationale:
          json === undefined
            ? `The model's reply was not parseable JSON, so ${q} is unknown.`
            : `The model gave no valid answer for ${q}.`,
      });
    }
  }
  return out;
}

export async function runJudge(input: JudgeInput, deps: JudgeDeps): Promise<JudgeResult> {
  const { client } = deps;
  const tracker = new BudgetTracker(input.budget);
  const calls: CallRecord[] = [];
  const asked: JudgeQuestion[] =
    input.plan === null ? ["hidden-behavior-change"] : [...JUDGE_QUESTIONS];
  // Without a plan the plan questions do not apply. They are reported as "skipped" (which the
  // classifier ignores) rather than "unsure": the classifier's own plan rules (plan.missing, or a
  // verified planless category) decide, and an "unsure" here would make planless Lane 0 impossible.
  const NOT_APPLICABLE =
    "No plan is attached: not applicable (the classifier's plan rules decide).";
  const fixed: LlmJudgment[] =
    input.plan === null
      ? [
          item("scope-drift", "unsure", NOT_APPLICABLE, client.model, "skipped", NOT_APPLICABLE),
          item(
            "plan-conformance",
            "unsure",
            NOT_APPLICABLE,
            client.model,
            "skipped",
            NOT_APPLICABLE,
          ),
        ]
      : [];
  const errored = (note: string): JudgeResult => ({
    items: [
      ...fixed,
      ...asked.map((q) => item(q, "unsure", `Not judged: ${note}`, client.model, "error", note)),
    ],
    costUsd: tracker.costUsd,
    budgetExceeded: tracker.exceeded,
    calls,
  });

  // Files a verified transform reproduced are listed by path only.
  const transformed = input.diff.files.filter((f) => f.transformVerified).map((f) => f.path);
  const reviewDiff = { ...input.diff, files: input.diff.files.filter((f) => !f.transformVerified) };
  const ranking = rankHunks({ diff: reviewDiff, evidence: [], plan: input.plan });
  const slots = ranking.map((r) => ({
    path: r.path,
    hunkIndex: r.hunkIndex,
    rank: r.rank,
    hasRisk: hasRisk(r),
  }));

  const overhead =
    estimateTokens(
      JUDGE_SYSTEM_PROMPT +
        buildJudgeUserPrompt({ plan: input.plan, diffText: "", questions: asked }),
    ) + 64;
  const affordable = affordableInputTokens(
    tracker.remainingUsd,
    client.model,
    deps.maxOutputTokens,
    deps.prices,
    client.allowedModels,
  );
  const fullTokens = renderDiff(reviewDiff, slots, Number.POSITIVE_INFINITY).tokens;
  const diffBudget = Math.min(deps.diffTokenBudget, affordable - overhead);
  if (diffBudget < Math.min(MIN_JUDGE_DIFF_TOKENS, fullTokens)) {
    tracker.markExceeded();
    return errored(
      `budget exceeded: $${tracker.remainingUsd.toFixed(4)} left cannot pay for a judge call`,
    );
  }
  const rendered = renderDiff(reviewDiff, slots, diffBudget);
  let diffText = rendered.text;
  if (transformed.length > 0) {
    diffText += `\n\n(${transformed.length} file(s) reproduced byte-for-byte by a verified transform are not shown: ${transformed.slice(0, 20).join(", ")})`;
  }
  if (rendered.omitted.length > 0 || rendered.partial.length > 0) {
    diffText += `\n\n(${rendered.omitted.length + rendered.partial.length} hunk(s) were omitted or cut short to fit the budget; answer "unsure" where that matters.)`;
  }

  const req = {
    system: JUDGE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: buildJudgeUserPrompt({ plan: input.plan, diffText, questions: asked }),
      },
    ],
    jsonSchema: { name: "judgments", schema: JUDGE_JSON_SCHEMA },
    maxTokens: deps.maxOutputTokens,
    metadata: {
      change_id: input.budget.changeId,
      purpose: "judge",
      head: input.diff.headSha.slice(0, 12),
      prompt: PROMPT_VERSION,
    },
  };
  const estimate = estimateCallCostUsd(
    client.model,
    req.system + req.messages[0]!.content,
    deps.maxOutputTokens,
    deps.prices,
    client.allowedModels,
  );
  if (!tracker.tryReserve(estimate)) {
    return errored(
      `budget exceeded: spent $${tracker.spentUsd.toFixed(4)} + estimate $${estimate.toFixed(4)} > limit $${tracker.limitUsd.toFixed(4)}`,
    );
  }

  let res: LlmResponse;
  try {
    res = await client.complete(req);
  } catch (err) {
    if (err instanceof LlmError && err.kind === "budget") tracker.markExceeded();
    return errored(`model call failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  tracker.charge(res.costUsd);
  const record: CallRecord = {
    purpose: "judge",
    attempt: 1,
    model: res.model,
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    costUsd: res.costUsd,
  };
  if (res.logId !== undefined) record.logId = res.logId;
  calls.push(record);

  const answers = parseJudgments(res, asked);
  const truncated = res.stopReason === "length" || res.stopReason === "max_tokens";
  const items = [
    ...fixed.map((f) => ({ ...f, model: res.model })),
    ...asked.map((q) => {
      const a = answers.get(q)!;
      return item(
        q,
        a.outcome,
        a.rationale,
        res.model,
        "ok",
        truncated ? "The model's reply hit the output limit." : undefined,
      );
    }),
  ];
  return { items, costUsd: tracker.costUsd, budgetExceeded: tracker.exceeded, calls };
}
