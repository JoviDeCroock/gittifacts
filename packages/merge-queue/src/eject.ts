/**
 * Ejection payloads (§5): each one tells the authoring agent exactly what to do next.
 */
import type { EjectCode, EjectReason } from "./schema.js";

export interface EjectInput {
  changeId: string;
  code: EjectCode;
  message: string;
  failingTests?: string[];
  upstream?: string[];
  evidenceRefs?: string[];
  files?: string[];
}

function list(xs: string[], max = 5): string {
  const head = xs.slice(0, max).join(", ");
  return xs.length > max ? `${head} (+${xs.length - max} more)` : head;
}

export function ejectReason(i: EjectInput): EjectReason {
  const failing = i.failingTests ?? [];
  const upstream = i.upstream ?? [];
  const files = i.files ?? [];
  const ws = `open_workspace({ changeId: "${i.changeId}" })`;
  const requeue = `enqueue({ changeId: "${i.changeId}" })`;
  let fix: EjectReason["fix"];
  switch (i.code) {
    case "tests-failed":
      fix = {
        explanation: `On the queue's tree (main + the batch ahead of it) your Change fails ${list(failing)}. The failure reproduced on that tree and not on main, so it is not a flake. Fix the test failures on top of current main, push, and enqueue again.`,
        call: ws,
        command: "git fetch origin main && git rebase origin/main",
      };
      break;
    case "semantic-conflict":
      fix = {
        explanation: `Your Change passes on its own but fails ${list(failing)} together with upstream ${list(upstream)}, and the resolver could not fix it. Rebase onto current main (which now contains ${list(upstream)}), adapt your Change to it, and enqueue again.`,
        call: ws,
        command: "git fetch origin main && git rebase origin/main",
      };
      break;
    case "textual-conflict":
      fix = {
        explanation: `Your Change no longer applies cleanly${files.length ? ` (${list(files)})` : ""}${upstream.length ? ` after ${list(upstream)}` : ""}, and the resolver could not resolve it twice. Rebase onto current main, resolve the conflicts, push and enqueue again.`,
        call: ws,
        command: "git fetch origin main && git rebase origin/main",
      };
      break;
    case "resolution-budget-exhausted":
      fix = {
        explanation:
          "The conflict resolver ran out of AI budget for this Change. Resolve the conflict yourself: rebase onto current main, push and enqueue again.",
        call: ws,
        command: "git fetch origin main && git rebase origin/main",
      };
      break;
    case "dependency-ejected":
      fix = {
        explanation: `This Change is stacked on ${list(upstream)}, which left the queue. Fix and re-enqueue ${list(upstream)} first, then enqueue this Change again.`,
        call: upstream[0] === undefined ? requeue : `queue_status({ changeId: "${upstream[0]}" })`,
      };
      break;
    case "group-member-failed":
      fix = {
        explanation: `This Change lands together with ${list(upstream)}, and one of them failed. Nothing in the group merged. Once the failing member is fixed, enqueue the whole group again.`,
        call: upstream[0] === undefined ? requeue : `queue_status({ changeId: "${upstream[0]}" })`,
      };
      break;
    case "infra-error":
      fix = {
        explanation:
          "CI could not produce a result for this Change several times in a row (infrastructure, not your code). Enqueue it again.",
        call: requeue,
      };
      break;
    case "superseded":
      fix = {
        explanation: "A newer head of this Change was enqueued; this one was replaced.",
        call: `queue_status({ changeId: "${i.changeId}" })`,
      };
      break;
  }
  return {
    code: i.code,
    message: i.message.slice(0, 2000),
    fix,
    evidenceRefs: (i.evidenceRefs ?? []).slice(0, 50),
    failingTests: failing.slice(0, 100),
    upstream: upstream.slice(0, 50),
  };
}
