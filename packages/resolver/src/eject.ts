/**
 * Machine-readable ejections (merge-queue §3 `EjectReason`): what went wrong, and a `fix` that
 * tells the Change's authoring agent exactly what to do next. The shape is structurally the merge
 * queue core's `EjectReason` plus a `cause`.
 */
import type { ErrorFix } from "@app/domain";

/** Why the resolver gave up. */
export type EjectCause =
  | "invalid-input"
  | "unsupported-conflict"
  | "self-resolution"
  | "budget-exceeded"
  | "model-unavailable"
  | "invalid-output"
  | "declined"
  | "not-a-conflict"
  | "apply-failed";

/** The merge queue's eject codes this resolver can produce. */
export type ResolverEjectCode =
  | "textual-conflict"
  | "semantic-conflict"
  | "resolution-budget-exhausted"
  | "tests-failed";

export interface ResolverEjectReason {
  code: ResolverEjectCode;
  cause: EjectCause;
  message: string;
  fix: ErrorFix;
  evidenceRefs: string[];
  failingTests: string[];
  /** Upstream Changes involved (the blamed one first for semantic conflicts). */
  upstream: string[];
}

export interface EjectContext {
  mode: "textual" | "semantic";
  changeId: string;
  ontoSha: string;
  files: readonly string[];
  upstream: readonly string[];
  failingTests: readonly string[];
  /** The upstream Change blamed for a semantic conflict, if known. */
  culprit: string | null;
  /** Evidence id of the errored conflict-resolution item. */
  evidenceRef: string;
}

function list(values: readonly string[], max = 4, empty = "(none)"): string {
  if (values.length === 0) return empty;
  const shown = values.slice(0, max).join(", ");
  return values.length > max ? `${shown} and ${values.length - max} more` : shown;
}

function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function ejectReason(
  cause: EjectCause,
  detail: string,
  ctx: EjectContext,
): ResolverEjectReason {
  const onto = ctx.ontoSha.slice(0, 12);
  const call = `open_workspace({ changeId: "${ctx.changeId}" })`;
  const rebase = `git fetch origin && git rebase ${ctx.ontoSha}`;
  const upstream = ctx.culprit
    ? [ctx.culprit, ...ctx.upstream.filter((u) => u !== ctx.culprit)]
    : [...ctx.upstream];
  const why = clip(detail, 600);
  let code: ResolverEjectCode = ctx.mode === "semantic" ? "semantic-conflict" : "textual-conflict";
  let message: string;
  let explanation: string;

  if (cause === "budget-exceeded") {
    code = "resolution-budget-exhausted";
    message = `The conflict resolver ran out of this change's AI budget: ${why}`;
  } else if (cause === "not-a-conflict") {
    code = "tests-failed";
    message = `No upstream change explains the failure: this change itself fails ${list(ctx.failingTests)} on the queue's tree. ${why}`;
  } else if (ctx.mode === "semantic") {
    message = `This change fails together with upstream ${list(upstream)} (${list(ctx.failingTests)}) and the resolver could not fix it: ${why}`;
  } else {
    message = `This change no longer applies onto ${onto}: ${list(ctx.files)} conflict with upstream ${list(upstream)}, and the resolver could not resolve it: ${why}`;
  }

  if (cause === "not-a-conflict") {
    explanation = `Open a workspace, rebase onto ${onto} and make ${list(ctx.failingTests)} pass, then push and enqueue again. The resolver found no upstream change to blame.`;
  } else if (ctx.mode === "semantic") {
    explanation = `Open a workspace and rebase onto ${onto}, which includes ${list(upstream)}. Your change passes alone but fails with ${ctx.culprit ?? "an upstream change"}: adapt your code to its new behaviour (do not weaken the failing tests ${list(ctx.failingTests)}), run the tests, push and enqueue again.`;
  } else {
    explanation = `Open a workspace and rebase onto ${onto}. Resolve the conflicts in ${list(ctx.files)} so that both your plan and upstream ${list(upstream)} keep working, run the tests, push and enqueue again.`;
  }

  return {
    code,
    cause,
    message: clip(message, 2000),
    fix: { explanation: clip(explanation, 2000), call, command: rebase },
    evidenceRefs: [ctx.evidenceRef],
    failingTests: [...ctx.failingTests].slice(0, 100),
    upstream: upstream.slice(0, 50),
  };
}
