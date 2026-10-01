/**
 * The resolver agent: resolves a Change's merge conflict (textual or semantic) with a model and
 * hands back a verified patch plus the `conflict-resolution` evidence item, or a machine-readable
 * ejection.
 *
 * Not the author: it runs as principal `system:resolver` (not configurable), in its own context.
 * Its prompt input is built from whitelisted fields only, so the author's summary, claim or trace
 * cannot reach the model. Facts about the resolution (which lines it touched, whether anything
 * outside the conflict hunks changed) are computed mechanically by @app/evidence, never taken
 * from the model. Budget: the per-change AI Gateway budget, as for the reviewer.
 */
import type { Plan } from "@app/domain";
import {
  type ConflictResolution,
  conflictResolutionError,
  conflictResolutionItem,
  type ResolutionScope,
  resolutionScope,
  type UpstreamChangeRef,
} from "@app/evidence";
import {
  affordableInputTokens,
  BudgetTracker,
  DEFAULT_PRICES,
  estimateCallCostUsd,
  estimateTokens,
  type LlmClient,
  LlmError,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type PriceTable,
  parseJsonLoose,
  type ReviewerBudget,
} from "@app/tour";
import type { z } from "zod";
import { applyModelResolution, type ResolvedFileChange } from "./apply.js";
import { type EjectCause, ejectReason, type ResolverEjectReason } from "./eject.js";
import { MergeAttempt } from "./merge-doc.js";
import { buildPatch, PatchError } from "./patch.js";
import {
  buildResolverPrompt,
  buildRetryPrompt,
  fitText,
  RESOLVER_PROMPT_VERSION,
  RESOLVER_SYSTEM_PROMPT,
  type ResolverPromptInput,
  renderConflicts,
  renderContextFiles,
} from "./prompt.js";
import { ModelResolution, RESOLUTION_JSON_SCHEMA } from "./schema.js";
import { buildWorkspace, type Workspace } from "./workspace.js";

/** The resolver's principal. Never the author's; not configurable. */
export const RESOLVER_PRINCIPAL_ID = "system:resolver";
export const RESOLUTION_EVIDENCE_ID = "conflict-resolution";

export interface UpstreamChangeInput {
  changeId: string;
  /** The upstream Change's merged commit. */
  sha: string;
  title: string;
  plan: Plan | null;
  /** Its unified diff. */
  diff: string;
}

export interface FailingTest {
  id: string;
  message?: string;
}

export interface SemanticConflictInput {
  failingTests: readonly FailingTest[];
  /** Bisection's candidates: changeIds of the upstream Changes the failure appeared with. */
  candidates: readonly string[];
}

export interface ContextFileInput {
  path: string;
  /** Content in the merge-attempt commit (the merged tree). */
  content: string;
  /** Git mode, default 100644. */
  mode?: string;
}

export interface ResolverInput {
  /** Only these Change fields can reach a prompt. */
  change: { id: string; title: string; baseSha: string; headSha: string };
  plan: Plan | null;
  /** The Change's own diff (base..head). */
  diff: string;
  upstream: readonly UpstreamChangeInput[];
  /** The runner's `merge-attempt` document (validated here). */
  merge: unknown;
  /** Present for a semantic conflict (found by batch bisection). */
  semantic?: SemanticConflictInput;
  /**
   * Merged-tree files besides the conflicted ones that the resolver may read and edit (files
   * either side touched, failing test files and the code they exercise). Edits to them count as
   * outside the conflict hunks.
   */
  files?: readonly ContextFileInput[];
  budget: ReviewerBudget;
  /** Principals that must not resolve this Change (its author, earlier resolvers' approvers). */
  excludePrincipals?: readonly string[];
}

export interface ResolverOptions {
  prices?: PriceTable;
  /** Output token ceiling per call (default: sized from the conflict, 2 000 to 16 000). */
  maxOutputTokens?: number;
  /** Upper bound on diff tokens in the prompt, before fitting to the budget (default 24 000). */
  diffTokenBudget?: number;
}

export interface ResolverCallRecord {
  purpose: "resolve";
  attempt: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  logId?: string;
}

export interface ResolverDiagnostics {
  mode: "textual" | "semantic" | "unknown";
  attempts: number;
  calls: ResolverCallRecord[];
  /** Problems found in each attempt's answer. */
  problems: string[][];
  maxOutputTokens: number;
  diffTokenBudget: number;
  regenerationReserved: boolean;
  /** Diffs cut to fit the budget. */
  cutDiffs: number;
  regions: number;
}

interface Common {
  costUsd: number;
  budgetExceeded: boolean;
  diagnostics: ResolverDiagnostics;
}

export type ResolutionOutcome =
  | (Common & {
      status: "resolved";
      /** Unified diff from `applyOnto` to the resolved tree: `apply-resolution --patch`. */
      patch: string;
      /** The commit the patch applies to (merge-attempt's conflictSha, or newSha if semantic). */
      applyOnto: string;
      files: Array<{ path: string; content: string | null }>;
      /** Computed mechanically from the merge and the resolved files. */
      scope: ResolutionScope;
      /** Status "ok"; goes into the merged tree's evidence bundle. */
      evidence: ConflictResolution;
      semanticConflictWith: string | null;
      rationale: string;
    })
  | (Common & {
      status: "ejected";
      eject: ResolverEjectReason;
      /** Status "error". */
      evidence: ConflictResolution;
    });

export interface ConflictResolver {
  readonly principalId: string;
  resolve(input: ResolverInput): Promise<ResolutionOutcome>;
}

const DEFAULT_DIFF_TOKENS = 24_000;
const MAX_ECHOED_REPLY_CHARS = 12_000;
const REGENERATION_EXTRA_TOKENS = estimateTokens("x".repeat(MAX_ECHOED_REPLY_CHARS)) + 800;
const MIN_DIFF_TOKENS = 600;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(text: string, max: number): string {
  const s = text.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Output ceiling sized from what the model may have to write back. */
function outputTokensFor(ws: Workspace): number {
  const chars =
    ws.conflicted.reduce((n, f) => n + (f.merged?.length ?? (f.sides.theirs ?? "").length), 0) +
    ws.context.reduce((n, f) => n + (f.abbreviated ? 0 : f.content.length), 0);
  return Math.min(
    16_000,
    Math.max(2_000, Math.ceil(estimateTokens("x".repeat(chars)) * 1.3) + 1_200),
  );
}

/** Split `budget` tokens over texts: small ones whole, the rest share what is left equally. */
function shareBudget(sizes: readonly number[], budget: number): number[] {
  const out = sizes.map(() => 0);
  let left = Math.max(0, budget);
  let open = sizes.map((_, i) => i);
  while (open.length > 0 && left > 0) {
    const share = Math.floor(left / open.length);
    const fits = open.filter((i) => sizes[i]! <= share);
    if (fits.length === 0) {
      for (const i of open) out[i] = share;
      break;
    }
    for (const i of fits) {
      out[i] = sizes[i]!;
      left -= sizes[i]!;
    }
    open = open.filter((i) => !fits.includes(i));
  }
  return out;
}

export function createResolver(client: LlmClient, opts: ResolverOptions = {}): ConflictResolver {
  const prices = opts.prices ?? DEFAULT_PRICES;
  return {
    principalId: RESOLVER_PRINCIPAL_ID,
    resolve: (input) => runResolver(input, client, prices, opts),
  };
}

async function runResolver(
  input: ResolverInput,
  client: LlmClient,
  prices: PriceTable,
  opts: ResolverOptions,
): Promise<ResolutionOutcome> {
  const tracker = new BudgetTracker(input.budget);
  const diagnostics: ResolverDiagnostics = {
    mode: input.semantic === undefined ? "textual" : "semantic",
    attempts: 0,
    calls: [],
    problems: [],
    maxOutputTokens: 0,
    diffTokenBudget: 0,
    regenerationReserved: false,
    cutDiffs: 0,
    regions: 0,
  };
  const mode = input.semantic === undefined ? "textual" : "semantic";
  const failingTests = (input.semantic?.failingTests ?? []).map((t) => t.id);
  const upstreamRefs: UpstreamChangeRef[] = input.upstream.map((u) => {
    const ref: UpstreamChangeRef = { changeId: u.changeId, sha: u.sha };
    if (u.plan !== null) ref.planId = u.plan.id;
    return ref;
  });
  const parsedMerge = MergeAttempt.safeParse(input.merge);
  const ontoSha =
    parsedMerge.success && parsedMerge.data.status !== "error"
      ? parsedMerge.data.onto
      : input.change.baseSha;
  let model = client.model;
  let lastRationale = "";

  const eject = (
    cause: EjectCause,
    detail: string,
    culprit: string | null = null,
  ): ResolutionOutcome => {
    const files =
      parsedMerge.success && parsedMerge.data.status === "conflict"
        ? parsedMerge.data.files.map((f) => f.path)
        : [];
    const evidence = conflictResolutionError({
      id: RESOLUTION_EVIDENCE_ID,
      note: `${cause}: ${detail}`,
      upstreamChanges: upstreamRefs,
      ...(parsedMerge.success && parsedMerge.data.status !== "error" ? { ontoSha } : {}),
      semanticConflictWith: culprit,
      ...(mode === "semantic" ? { failingTests } : {}),
      rationale: lastRationale,
      resolver: {
        model,
        principalId: RESOLVER_PRINCIPAL_ID,
        promptVersion: RESOLVER_PROMPT_VERSION,
      },
      attempts: diagnostics.attempts,
    });
    return {
      status: "ejected",
      eject: ejectReason(cause, detail, {
        mode,
        changeId: input.change.id,
        ontoSha,
        files,
        upstream: input.upstream.map((u) => u.changeId),
        failingTests,
        culprit,
        evidenceRef: RESOLUTION_EVIDENCE_ID,
      }),
      evidence,
      costUsd: tracker.costUsd,
      budgetExceeded: tracker.exceeded,
      diagnostics,
    };
  };

  if (input.excludePrincipals?.includes(RESOLVER_PRINCIPAL_ID))
    return eject("self-resolution", `${RESOLVER_PRINCIPAL_ID} may not resolve this change`);
  if (!parsedMerge.success)
    return eject(
      "invalid-input",
      `the merge-attempt document is invalid: ${clip(parsedMerge.error.message, 500)}`,
    );
  const built = buildWorkspace(parsedMerge.data, input.files ?? [], input.semantic !== undefined);
  if (!built.ok) return eject(built.cause, built.message);
  const ws = built.ws;
  diagnostics.regions = ws.conflicted.reduce((n, f) => n + (f.wholeFile ? 1 : f.regions.length), 0);

  // ---- prompt, fitted to the budget
  const maxTokens = opts.maxOutputTokens ?? outputTokensFor(ws);
  diagnostics.maxOutputTokens = maxTokens;
  const promptInput: ResolverPromptInput = {
    mode,
    change: {
      id: input.change.id,
      title: input.change.title,
      baseSha: input.change.baseSha,
      headSha: input.change.headSha,
    },
    plan: input.plan,
    ontoSha: ws.ontoSha,
    changeDiff: "",
    upstream: input.upstream.map((u) => ({
      changeId: u.changeId,
      sha: u.sha,
      title: u.title,
      plan: u.plan,
      diff: "",
    })),
    conflicts: renderConflicts(ws),
    failingTests: input.semantic?.failingTests ?? [],
    candidates: input.semantic?.candidates ?? [],
    contextFiles: renderContextFiles(ws.context),
    regionCount: diagnostics.regions,
    fileCount: ws.conflicted.length,
  };
  const overhead = estimateTokens(RESOLVER_SYSTEM_PROMPT + buildResolverPrompt(promptInput)) + 128;
  const affordable = affordableInputTokens(
    tracker.remainingUsd,
    client.model,
    maxTokens,
    prices,
    client.allowedModels,
  );
  if (affordable < overhead) {
    tracker.markExceeded();
    return eject(
      "budget-exceeded",
      `$${tracker.remainingUsd.toFixed(4)} left of $${tracker.limitUsd.toFixed(4)} cannot pay for one resolution call (${overhead} input tokens before any diff)`,
    );
  }
  const diffs = [input.diff, ...input.upstream.map((u) => u.diff)];
  const fullDiffTokens = diffs.reduce((n, d) => n + estimateTokens(d), 0);
  const cap = opts.diffTokenBudget ?? DEFAULT_DIFF_TOKENS;
  let diffBudget = Math.min(cap, affordable - overhead);
  const affordableTwo = affordableInputTokens(
    tracker.remainingUsd,
    client.model,
    2 * maxTokens,
    prices,
    client.allowedModels,
  );
  const twoCalls = Math.min(
    cap,
    Math.floor((affordableTwo - REGENERATION_EXTRA_TOKENS) / 2) - overhead,
  );
  if (twoCalls >= Math.min(MIN_DIFF_TOKENS, fullDiffTokens)) {
    diffBudget = twoCalls;
    diagnostics.regenerationReserved = true;
  }
  diagnostics.diffTokenBudget = Math.max(0, diffBudget);
  const shares = shareBudget(
    diffs.map((d) => estimateTokens(d)),
    Math.max(0, diffBudget),
  );
  const fitted = diffs.map((d, i) => fitText(d, shares[i]! * 3));
  diagnostics.cutDiffs = fitted.filter((f) => f.cut).length;
  promptInput.changeDiff = fitted[0]!.text;
  promptInput.upstream = promptInput.upstream.map((u, i) => ({ ...u, diff: fitted[i + 1]!.text }));

  // ---- at most two attempts: the second one sees what was wrong with the first
  const messages: LlmMessage[] = [{ role: "user", content: buildResolverPrompt(promptInput) }];
  let lastProblem = "no attempt was made";
  let modelFailed = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const req: LlmRequest = {
      system: RESOLVER_SYSTEM_PROMPT,
      messages: [...messages],
      jsonSchema: { name: "resolution", schema: RESOLUTION_JSON_SCHEMA },
      maxTokens,
      metadata: {
        change_id: input.budget.changeId,
        purpose: "resolve",
        head: input.change.headSha.slice(0, 12),
        attempt,
        prompt: RESOLVER_PROMPT_VERSION,
      },
    };
    const estimate = estimateCallCostUsd(
      client.model,
      req.system + req.messages.map((m) => m.content).join("\n"),
      req.maxTokens,
      prices,
      client.allowedModels,
    );
    if (!tracker.tryReserve(estimate)) {
      return eject(
        "budget-exceeded",
        `spent $${tracker.spentUsd.toFixed(4)} + estimate $${estimate.toFixed(4)} > limit $${tracker.limitUsd.toFixed(4)}${attempt > 1 ? ` (before regenerating; previous problems: ${clip(lastProblem, 300)})` : ""}`,
      );
    }
    diagnostics.attempts = attempt;
    let res: LlmResponse;
    try {
      res = await client.complete(req);
    } catch (err) {
      if (err instanceof LlmError && err.kind === "budget") {
        tracker.markExceeded();
        return eject("budget-exceeded", `AI Gateway refused the call (${clip(err.message, 200)})`);
      }
      modelFailed = true;
      lastProblem = `model call failed: ${errorMessage(err)}`;
      diagnostics.problems.push([lastProblem]);
      continue;
    }
    modelFailed = false;
    tracker.charge(res.costUsd);
    model = res.model;
    const record: ResolverCallRecord = {
      purpose: "resolve",
      attempt,
      model: res.model,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd: res.costUsd,
    };
    if (res.logId !== undefined) record.logId = res.logId;
    diagnostics.calls.push(record);

    const checked = check(res, ws, input);
    if (checked.kind === "eject") {
      lastRationale = checked.rationale;
      return eject(checked.cause, checked.detail, checked.culprit);
    }
    if (checked.kind === "ok") {
      lastRationale = checked.rationale;
      const evidence = conflictResolutionItem({
        id: RESOLUTION_EVIDENCE_ID,
        upstreamChanges: upstreamRefs,
        ontoSha: ws.ontoSha,
        scope: checked.scope,
        resolutionDiff: checked.patch,
        semanticConflictWith: checked.semanticConflictWith,
        ...(mode === "semantic" ? { failingTests } : {}),
        rationale: checked.rationale,
        resolver: {
          model,
          principalId: RESOLVER_PRINCIPAL_ID,
          promptVersion: RESOLVER_PROMPT_VERSION,
        },
        attempts: attempt,
      });
      return {
        status: "resolved",
        patch: checked.patch,
        applyOnto: ws.applyOnto,
        files: checked.files.map((f) => ({ path: f.path, content: f.after })),
        scope: checked.scope,
        evidence,
        semanticConflictWith: checked.semanticConflictWith,
        rationale: checked.rationale,
        costUsd: tracker.costUsd,
        budgetExceeded: tracker.exceeded,
        diagnostics,
      };
    }
    lastProblem = checked.problems.join("\n");
    diagnostics.problems.push(checked.problems);
    messages.push(
      {
        role: "assistant",
        content: clip(res.text === "" ? "(empty reply)" : res.text, MAX_ECHOED_REPLY_CHARS),
      },
      {
        role: "user",
        content: buildRetryPrompt(
          checked.problems
            .slice(0, 20)
            .map((p) => `- ${p}`)
            .join("\n"),
        ),
      },
    );
  }
  if (modelFailed) return eject("model-unavailable", lastProblem);
  return eject(
    "invalid-output",
    `the answer was unusable after ${diagnostics.attempts} attempt(s): ${clip(lastProblem, 1500)}`,
  );
}

type Checked =
  | {
      kind: "ok";
      files: ResolvedFileChange[];
      patch: string;
      scope: ResolutionScope;
      semanticConflictWith: string | null;
      rationale: string;
    }
  | { kind: "retry"; problems: string[] }
  | { kind: "eject"; cause: EjectCause; detail: string; culprit: string | null; rationale: string };

function formatIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((issue) => {
    const path = issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".");
    return `${path}: ${issue.message}`;
  });
}

/** Validate one answer. Everything the evidence says is recomputed here, not read from it. */
function check(res: LlmResponse, ws: Workspace, input: ResolverInput): Checked {
  const cutOff = res.stopReason === "length" || res.stopReason === "max_tokens";
  const json = res.json ?? parseJsonLoose(res.text);
  if (json === undefined) {
    return {
      kind: "retry",
      problems: [
        cutOff
          ? "The reply was cut off at the output limit before the JSON was complete. Resolve regions instead of repeating whole files."
          : "The reply was not a JSON object.",
      ],
    };
  }
  const parsed = ModelResolution.safeParse(json);
  if (!parsed.success) return { kind: "retry", problems: formatIssues(parsed.error) };
  const answer = parsed.data;
  const upstreamIds = input.upstream.map((u) => u.changeId);
  const candidates =
    input.semantic && input.semantic.candidates.length > 0
      ? input.semantic.candidates
      : upstreamIds;

  if (answer.status === "cannot-resolve")
    return {
      kind: "eject",
      cause: "declined",
      detail: clip(answer.rationale, 1500),
      culprit: null,
      rationale: answer.rationale,
    };
  if (answer.status === "not-a-conflict") {
    if (ws.mode !== "semantic")
      return {
        kind: "retry",
        problems: [
          '"not-a-conflict" only applies to semantic conflicts; this is a textual conflict.',
        ],
      };
    return {
      kind: "eject",
      cause: "not-a-conflict",
      detail: clip(answer.rationale, 1500),
      culprit: null,
      rationale: answer.rationale,
    };
  }

  const problems: string[] = [];
  let culprit: string | null = null;
  if (ws.mode === "semantic") {
    if (answer.semanticConflictWith === null || !candidates.includes(answer.semanticConflictWith))
      problems.push(
        `"semanticConflictWith" must name the upstream change that caused the conflict, one of: ${candidates.join(", ") || "(none given)"}.`,
      );
    else culprit = answer.semanticConflictWith;
  }
  // Textual conflicts have no culprit; a model's claim otherwise is ignored, never trusted.

  const applied = applyModelResolution(ws, answer);
  if (!applied.ok) problems.push(...applied.problems);
  if (problems.length > 0 || !applied.ok) return { kind: "retry", problems };

  let patch: string;
  try {
    patch = buildPatch(applied.files);
  } catch (e) {
    return { kind: "retry", problems: [e instanceof PatchError ? e.message : errorMessage(e)] };
  }
  const changed = new Set(applied.files.map((f) => f.path));
  const scope = resolutionScope(
    [
      ...applied.files.map((f) => ({
        path: f.path,
        merged: f.before,
        resolved: f.after,
        conflicted: f.conflicted,
        wholeFile: f.wholeFile,
        ...(f.sides ? { sides: f.sides } : {}),
      })),
      // Conflicted files the answer left as they were still count (their regions stay regions).
      ...ws.conflicted
        .filter((f) => !changed.has(f.path))
        .map((f) => ({
          path: f.path,
          merged: f.merged,
          resolved: f.merged,
          conflicted: true,
          wholeFile: f.wholeFile,
          sides: f.sides,
        })),
    ],
    ws.markers,
  );
  if (scope.unresolvedFiles.length > 0)
    return {
      kind: "retry",
      problems: [`Conflict markers remain in ${scope.unresolvedFiles.join(", ")}.`],
    };
  return {
    kind: "ok",
    files: applied.files,
    patch,
    scope,
    semanticConflictWith: culprit,
    rationale: answer.rationale,
  };
}

/**
 * The runner could not apply a resolved outcome's patch (`apply-resolution` returned an error):
 * eject with the same evidence trail. For the queue shell.
 */
export function applyFailed(
  outcome: Extract<ResolutionOutcome, { status: "resolved" }>,
  input: Pick<ResolverInput, "change" | "upstream" | "semantic">,
  note: string,
): Extract<ResolutionOutcome, { status: "ejected" }> {
  const mode = input.semantic === undefined ? "textual" : "semantic";
  const failingTests = (input.semantic?.failingTests ?? []).map((t) => t.id);
  const detail = `the resolution patch did not apply: ${clip(note, 1000)}`;
  const evidence = conflictResolutionError({
    id: RESOLUTION_EVIDENCE_ID,
    note: `apply-failed: ${detail}`,
    upstreamChanges: outcome.evidence.upstreamChanges,
    ...(outcome.evidence.ontoSha !== undefined ? { ontoSha: outcome.evidence.ontoSha } : {}),
    semanticConflictWith: outcome.semanticConflictWith,
    ...(mode === "semantic" ? { failingTests } : {}),
    rationale: outcome.rationale,
    resolver: outcome.evidence.resolver,
    attempts: outcome.evidence.attempts,
  });
  return {
    status: "ejected",
    eject: ejectReason("apply-failed", detail, {
      mode,
      changeId: input.change.id,
      ontoSha: outcome.evidence.ontoSha ?? input.change.baseSha,
      files: outcome.scope.files.map((f) => f.path),
      upstream: input.upstream.map((u) => u.changeId),
      failingTests,
      culprit: outcome.semanticConflictWith,
      evidenceRef: RESOLUTION_EVIDENCE_ID,
    }),
    evidence,
    costUsd: outcome.costUsd,
    budgetExceeded: outcome.budgetExceeded,
    diagnostics: outcome.diagnostics,
  };
}
