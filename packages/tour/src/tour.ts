/**
 * The reviewer agent: writes the guided tour and the LLM judgments.
 *
 * Implements the coordinator's `Reviewer` port structurally (this package does not depend on
 * `@app/coordinator`; `apps/platform` assigns `createReviewer(...)` to `Reviewer`). The outcomes
 * carry extra fields (readability, diagnostics) that the port simply ignores.
 *
 * Separation from the author: the reviewer copies only whitelisted fields of the change
 * (id, title, shas) into its prompt input; `Change.claim.summary` has no path into a prompt.
 */
import type { ClassifyResult } from "@app/classifier";
import { type Change, type ChangeDiff, type Plan, Tour } from "@app/domain";
import type { SignedEvidence } from "@app/evidence";
import {
  affordableInputTokens,
  BudgetTracker,
  DEFAULT_PRICES,
  estimateCallCostUsd,
  estimateTokens,
  type PriceTable,
  type ReviewerBudget,
} from "./budget.js";
import { type OmittedHunk, renderDiff } from "./diff.js";
import { type CallRecord, type JudgeInput, type JudgeResult, runJudge } from "./judge.js";
import {
  type LlmClient,
  LlmError,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  parseJsonLoose,
} from "./llm.js";
import {
  capsForLane,
  collapseTransforms,
  countWords,
  type PostprocessReport,
  postprocessTour,
  type Readability,
} from "./postprocess.js";
import {
  buildRetryPrompt,
  buildTourUserPrompt,
  PROMPT_VERSION,
  TOUR_SYSTEM_PROMPT,
  type TourPromptInput,
} from "./prompt.js";
import { hasRisk, type RankedHunk, rankHunks } from "./rank.js";
import { formatIssues, ModelTour, TOUR_JSON_SCHEMA } from "./schema.js";

export interface ReviewerOptions {
  /** Principal recorded in `Tour.generatedBy` (the reviewer agent, never the author). */
  principalId?: string;
  prices?: PriceTable;
  /** Output token limits per call. Defaults: tour 6000, judge 1500. */
  maxOutputTokens?: { tour?: number; judge?: number };
  /** Upper bound on diff tokens in a prompt, before fitting to the budget. Defaults: tour 24 000, judge 16 000. */
  diffTokenBudget?: { tour?: number; judge?: number };
  now?: () => Date;
  newId?: () => string;
}

/** The coordinator's `Reviewer.tour` input. */
export interface TourInput {
  change: Pick<Change, "id" | "title" | "headSha" | "baseSha">;
  plan: Plan | null;
  diff: ChangeDiff;
  evidence: SignedEvidence;
  classification: ClassifyResult;
  budget: ReviewerBudget;
}

export interface TourDiagnostics {
  attempts: number;
  calls: CallRecord[];
  /** Top of the deterministic risk ranking. */
  ranking: Array<{ rank: number; ref: string; factors: string[] }>;
  collapsedFiles: string[];
  omittedHunks: OmittedHunk[];
  diffTokenBudget: number;
  /** The diff was sized so that the first call and one regeneration both fit the budget. */
  regenerationReserved: boolean;
  postprocess?: PostprocessReport;
}

export type TourOutcome =
  | {
      status: "ok";
      tour: Tour;
      costUsd: number;
      budgetExceeded: boolean;
      /** Words, stops and `estimatedReadSeconds` (lane ≤ 1 target: under 180 s on a phone). */
      readability: Readability;
      diagnostics: TourDiagnostics;
    }
  | {
      status: "failed";
      reason: string;
      costUsd: number;
      budgetExceeded: boolean;
      diagnostics: TourDiagnostics;
    };

/** Structurally a `Reviewer` (coordinator port) with richer results. */
export interface TourReviewer {
  judge(input: JudgeInput): Promise<JudgeResult>;
  tour(input: TourInput): Promise<TourOutcome>;
}

const DEFAULTS = {
  principalId: "reviewer-agent",
  tourMaxTokens: 6000,
  judgeMaxTokens: 1500,
  tourDiffTokens: 24_000,
  judgeDiffTokens: 16_000,
} as const;
const MIN_TOUR_DIFF_TOKENS = 800;
/** Diffs smaller than this get budget for one regeneration reserved up front (README: Budget). */
export const REGENERATION_RESERVE_MAX_DIFF_TOKENS = 8000;
/** The previous reply is echoed back to the model at most this long. */
const MAX_ECHOED_REPLY_CHARS = 12_000;
/** Extra input of the regeneration call: the echoed reply plus the retry message (≤ 20 issues). */
const REGENERATION_EXTRA_TOKENS = estimateTokens("x".repeat(MAX_ECHOED_REPLY_CHARS)) + 800;
/** Words kept free for the platform's own notes when telling the model its word limit. */
const PLATFORM_WORD_RESERVE = 40;

interface Deps {
  client: LlmClient;
  prices: PriceTable;
  principalId: string;
  tourMaxTokens: number;
  judgeMaxTokens: number;
  tourDiffTokens: number;
  judgeDiffTokens: number;
  now: () => Date;
  newId: () => string;
}

export function createReviewer(client: LlmClient, opts: ReviewerOptions = {}): TourReviewer {
  const deps: Deps = {
    client,
    prices: opts.prices ?? DEFAULT_PRICES,
    principalId: opts.principalId ?? DEFAULTS.principalId,
    tourMaxTokens: opts.maxOutputTokens?.tour ?? DEFAULTS.tourMaxTokens,
    judgeMaxTokens: opts.maxOutputTokens?.judge ?? DEFAULTS.judgeMaxTokens,
    tourDiffTokens: opts.diffTokenBudget?.tour ?? DEFAULTS.tourDiffTokens,
    judgeDiffTokens: opts.diffTokenBudget?.judge ?? DEFAULTS.judgeDiffTokens,
    now: opts.now ?? (() => new Date()),
    newId: opts.newId ?? (() => `tour_${crypto.randomUUID()}`),
  };
  return {
    judge: (input) =>
      runJudge(input, {
        client,
        prices: deps.prices,
        maxOutputTokens: deps.judgeMaxTokens,
        diffTokenBudget: deps.judgeDiffTokens,
      }),
    tour: (input) => runTour(input, deps),
  };
}

function clip(text: string, max: number): string {
  const s = text.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fmtRef(r: RankedHunk): string {
  return `${r.path}:${r.ref.side === "base" ? "base " : ""}${r.ref.startLine}-${r.ref.endLine}`;
}

type Validation = { ok: true; tour: ModelTour } | { ok: false; problems: string };

export function validateModelTour(
  res: Pick<LlmResponse, "text" | "json" | "stopReason">,
): Validation {
  const cutOff = res.stopReason === "length" || res.stopReason === "max_tokens";
  const json = res.json ?? parseJsonLoose(res.text);
  if (json === undefined) {
    return {
      ok: false,
      problems: cutOff
        ? "- The reply was cut off at the output limit before the JSON was complete. Be more concise."
        : "- The reply was not a JSON object.",
    };
  }
  const parsed = ModelTour.safeParse(json);
  if (!parsed.success) return { ok: false, problems: formatIssues(parsed.error) };
  return { ok: true, tour: parsed.data };
}

function notDoneNotes(omitted: readonly OmittedHunk[], partial: number): string[] {
  const notes: string[] = [];
  const budget = omitted.filter((o) => o.why === "budget");
  if (budget.length > 0 || partial > 0) {
    const files = [...new Set(budget.map((o) => o.path))];
    const shown = files.slice(0, 4).join(", ");
    const more = files.length > 4 ? ` and ${files.length - 4} more` : "";
    notes.push(
      `The reviewer agent did not read ${budget.length + partial} hunk(s) in full to stay within the budget${files.length > 0 ? ` (${shown}${more})` : ""}.`,
    );
  }
  if (omitted.some((o) => o.why === "lockfile")) {
    notes.push(
      "Lockfile hunks were not read line by line; the dependencies evidence summarizes them.",
    );
  }
  return notes;
}

async function runTour(input: TourInput, deps: Deps): Promise<TourOutcome> {
  const { client } = deps;
  const tracker = new BudgetTracker(input.budget);
  const diagnostics: TourDiagnostics = {
    attempts: 0,
    calls: [],
    ranking: [],
    collapsedFiles: [],
    omittedHunks: [],
    diffTokenBudget: 0,
    regenerationReserved: false,
  };
  const fail = (reason: string): TourOutcome => ({
    status: "failed",
    reason,
    costUsd: tracker.costUsd,
    budgetExceeded: tracker.exceeded,
    diagnostics,
  });

  // The tour is bound to one head. Mismatched inputs are an error, never a guess.
  const headSha = input.diff.headSha;
  if (input.change.headSha !== null && input.change.headSha !== headSha) {
    return fail(`diff is for head ${headSha} but the change is at ${input.change.headSha}`);
  }
  if (input.evidence.headSha !== headSha) {
    return fail(`evidence is for head ${input.evidence.headSha} but the diff is for ${headSha}`);
  }
  if (input.evidence.changeId !== input.change.id) {
    return fail(`evidence is for change ${input.evidence.changeId}, not ${input.change.id}`);
  }

  // Whitelist: only these change fields can reach a prompt.
  const subject: TourPromptInput["change"] = {
    id: input.change.id,
    title: input.change.title,
    headSha,
    baseSha: input.diff.baseSha,
  };
  const items = input.evidence.items;
  const caps = capsForLane(input.classification.lane);

  const collapse = collapseTransforms(input.diff, items);
  diagnostics.collapsedFiles = [...collapse.paths];
  const reviewDiff: ChangeDiff = {
    ...input.diff,
    files: input.diff.files.filter((f) => !collapse.paths.has(f.path)),
  };
  const ranking = rankHunks({
    diff: input.diff,
    evidence: items,
    plan: input.plan,
    reasons: input.classification.reasons,
    exclude: collapse.paths,
  });
  diagnostics.ranking = ranking
    .slice(0, 10)
    .map((r) => ({ rank: r.rank, ref: fmtRef(r), factors: r.factors.map((f) => f.detail) }));
  const slots = ranking.map((r) => ({
    path: r.path,
    hunkIndex: r.hunkIndex,
    rank: r.rank,
    hasRisk: hasRisk(r),
  }));

  const transformWords = collapse.stop
    ? countWords(collapse.stop.title) + countWords(collapse.stop.why)
    : 0;
  const promptInput: TourPromptInput = {
    change: subject,
    plan: input.plan,
    classification: {
      lane: input.classification.lane,
      computedLane: input.classification.computedLane,
      requiresHumanApproval: input.classification.requiresHumanApproval,
      reasons: input.classification.reasons,
    },
    evidence: items,
    ranking,
    diffText: "",
    collapsed: { transforms: collapse.transforms, files: collapse.paths.size },
    omittedHunks: 0,
    limits: {
      lane: caps.lane,
      maxStops: caps.maxStops - (collapse.stop ? 1 : 0),
      maxWords: Math.max(150, caps.maxWords - transformWords - PLATFORM_WORD_RESERVE),
    },
  };

  // Fit the diff to what the remaining budget can pay for (one call, worst-case output).
  // Everything but the diff, plus slack for the omitted-hunks line, escaping and rounding.
  const overhead = estimateTokens(TOUR_SYSTEM_PROMPT + buildTourUserPrompt(promptInput)) + 128;
  const affordable = affordableInputTokens(
    tracker.remainingUsd,
    client.model,
    deps.tourMaxTokens,
    deps.prices,
    client.allowedModels,
  );
  const fullTokens = renderDiff(reviewDiff, slots, Number.POSITIVE_INFINITY).tokens;
  let diffBudget = Math.min(deps.tourDiffTokens, affordable - overhead);
  // Small diffs: also reserve one regeneration, i.e. size D so that both calls fit:
  //   (O + D)·in + M·out  +  (O + D + R)·in + M·out  ≤  remaining
  //   ⇒ D ≤ (affordable(2M) − R) / 2 − O,   with affordable(2M) = (remaining − 2M·out) / in.
  if (fullTokens < REGENERATION_RESERVE_MAX_DIFF_TOKENS) {
    const affordableTwo = affordableInputTokens(
      tracker.remainingUsd,
      client.model,
      2 * deps.tourMaxTokens,
      deps.prices,
      client.allowedModels,
    );
    const twoCalls = Math.min(
      deps.tourDiffTokens,
      Math.floor((affordableTwo - REGENERATION_EXTRA_TOKENS) / 2) - overhead,
    );
    if (twoCalls >= Math.min(MIN_TOUR_DIFF_TOKENS, fullTokens)) {
      diffBudget = twoCalls;
      diagnostics.regenerationReserved = true;
    }
  }
  diagnostics.diffTokenBudget = Math.max(0, diffBudget);
  if (diffBudget < Math.min(MIN_TOUR_DIFF_TOKENS, fullTokens)) {
    tracker.markExceeded();
    return fail(
      `budget exceeded: $${tracker.remainingUsd.toFixed(4)} left of $${tracker.limitUsd.toFixed(4)} cannot pay for a tour of this diff`,
    );
  }
  const rendered = renderDiff(reviewDiff, slots, diffBudget);
  diagnostics.omittedHunks = rendered.omitted;
  promptInput.diffText = rendered.text;
  promptInput.omittedHunks =
    rendered.omitted.filter((o) => o.why === "budget").length + rendered.partial.length;

  const messages: LlmMessage[] = [{ role: "user", content: buildTourUserPrompt(promptInput) }];
  let model = client.model;
  let parsed: ModelTour | null = null;
  let lastProblem = "no attempt was made";

  for (let attempt = 1; attempt <= 2 && parsed === null; attempt++) {
    const req: LlmRequest = {
      system: TOUR_SYSTEM_PROMPT,
      messages: [...messages],
      jsonSchema: { name: "tour", schema: TOUR_JSON_SCHEMA },
      maxTokens: deps.tourMaxTokens,
      metadata: {
        change_id: input.budget.changeId,
        purpose: "tour",
        head: headSha.slice(0, 12),
        attempt,
        prompt: PROMPT_VERSION,
      },
    };
    const estimate = estimateCallCostUsd(
      client.model,
      req.system + req.messages.map((m) => m.content).join("\n"),
      req.maxTokens,
      deps.prices,
      client.allowedModels,
    );
    if (!tracker.tryReserve(estimate)) {
      const after =
        attempt > 1 ? ` (before regenerating; previous problems: ${clip(lastProblem, 300)})` : "";
      return fail(
        `budget exceeded: spent $${tracker.spentUsd.toFixed(4)} + estimate $${estimate.toFixed(4)} > limit $${tracker.limitUsd.toFixed(4)}${after}`,
      );
    }

    diagnostics.attempts = attempt;
    let res: LlmResponse;
    try {
      res = await client.complete(req);
    } catch (err) {
      if (err instanceof LlmError && err.kind === "budget") {
        tracker.markExceeded();
        return fail(`budget exceeded: AI Gateway refused the call (${clip(err.message, 200)})`);
      }
      lastProblem = `model call failed: ${err instanceof Error ? err.message : String(err)}`;
      continue; // retry the same request once
    }
    tracker.charge(res.costUsd);
    model = res.model;
    const record: CallRecord = {
      purpose: "tour",
      attempt,
      model: res.model,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd: res.costUsd,
    };
    if (res.logId !== undefined) record.logId = res.logId;
    diagnostics.calls.push(record);

    const check = validateModelTour(res);
    if (check.ok) {
      parsed = check.tour;
      break;
    }
    lastProblem = check.problems;
    messages.push(
      {
        role: "assistant",
        content: clip(res.text === "" ? "(empty reply)" : res.text, MAX_ECHOED_REPLY_CHARS),
      },
      { role: "user", content: buildRetryPrompt(check.problems) },
    );
  }
  if (parsed === null) {
    return fail(
      `tour output invalid after ${diagnostics.attempts} attempt(s):\n${clip(lastProblem, 1500)}`,
    );
  }

  const post = postprocessTour({
    model: parsed,
    diff: input.diff,
    evidence: items,
    reasons: input.classification.reasons,
    ranking,
    transformStop: collapse.stop,
    caps,
    notDoneNotes: notDoneNotes(rendered.omitted, rendered.partial.length),
  });
  diagnostics.postprocess = post.report;

  const tour = Tour.safeParse({
    id: deps.newId(),
    changeId: subject.id,
    headSha,
    stops: post.stops,
    leastConfident: post.leastConfident,
    notDone: post.notDone,
    generatedBy: {
      principalId: deps.principalId,
      model,
      promptVersion: PROMPT_VERSION,
      attempts: diagnostics.attempts,
      costUsd: tracker.costUsd,
    },
    createdAt: deps.now().toISOString(),
  });
  if (!tour.success)
    return fail(`post-processed tour failed the Tour schema:\n${formatIssues(tour.error)}`);

  return {
    status: "ok",
    tour: tour.data,
    costUsd: tracker.costUsd,
    budgetExceeded: tracker.exceeded,
    readability: post.readability,
    diagnostics,
  };
}
