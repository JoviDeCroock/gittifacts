/**
 * Asking for QA from GitHub (docs/research/agentic-qa.md §1): the check run's **Run QA** button,
 * or a PR comment whose first line is `/gittifacts qa`. Either way the sender is re-checked with
 * GitHub every time: a human with write access (the author may ask: QA only adds scrutiny). No
 * comment is written back: the comment gets an 👀 reaction, and the result lands in the summary
 * comment and the check run when the run ends.
 */
import { z } from "zod";
import { changeIdFor } from "./ids.js";
import { identityOf } from "./normalize.js";
import { GithubAccount, type GithubDelivery, GithubRepo } from "./payloads.js";
import { QA_TERMS } from "./qa-section.js";
import type { GithubSyncDeps, SyncOutcome } from "./sync.js";

export type QaTrigger = "github-check" | "github-comment";

/** What the platform does with a request (`requestQa`): a run id, or why it refused. */
export interface GithubQaPort {
  request(input: {
    changeId: string;
    principalId: string;
    login: string;
    via: QaTrigger;
  }): Promise<{ runId: string; reused: boolean } | { refused: string }>;
}

const Comment = z.object({
  action: z.literal("created"),
  issue: z
    .object({
      number: z.number().int().positive(),
      pull_request: z.object({}).passthrough().optional(),
    })
    .passthrough(),
  comment: z
    .object({ id: z.number().int(), body: z.string().max(65_536), user: GithubAccount })
    .passthrough(),
  repository: GithubRepo,
  sender: GithubAccount,
});

/** `/gittifacts qa` as the comment's first line (case-insensitive, nothing else on that line). */
export function isQaCommand(body: string): boolean {
  const first = body.trimStart().split(/\r?\n/, 1)[0] ?? "";
  return first.trim().toLowerCase() === QA_TERMS.commentCommand;
}

/** Who may ask: a human with write access (re-checked with GitHub). Null = may; else why not. */
export async function mayAskForQa(
  deps: GithubSyncDeps,
  who: { kind: string; login: string },
): Promise<string | null> {
  if (who.kind !== "human") return `${who.login} is not a human: only people ask for QA`;
  if (deps.host.publisher === null || !(await deps.host.publisher.canWrite(who.login)))
    return `${who.login} has no write access to the repository`;
  return null;
}

export async function askForQa(
  deps: GithubSyncDeps,
  input: { event: string; changeId: string; account: GithubAccount; via: QaTrigger },
): Promise<SyncOutcome> {
  const who = { ...identityOf(input.account), login: input.account.login };
  const refuse = async (reason: string): Promise<SyncOutcome> => {
    await deps.ports.audit.append({
      principalId: "system",
      action: "github.qa-refused",
      subject: `change:${input.changeId}`,
      payload: { reason, via: input.via, login: who.login },
    });
    return { event: input.event, action: "ignored", detail: reason, changeId: input.changeId };
  };
  if (deps.qa === undefined) return refuse("QA is not available on this platform");
  const why = await mayAskForQa(deps, who);
  if (why !== null) return refuse(why);
  const principalId = await (deps.reviewerPrincipal ?? deps.authorPrincipal)(who);
  const out = await deps.qa.request({
    changeId: input.changeId,
    principalId,
    login: who.login,
    via: input.via,
  });
  if ("refused" in out) return refuse(out.refused);
  return {
    event: input.event,
    action: "recorded",
    detail: `qa ${out.reused ? "already requested" : "requested"} by ${who.login} (${out.runId})`,
    changeId: input.changeId,
  };
}

export async function onQaComment(
  deps: GithubSyncDeps,
  delivery: GithubDelivery,
): Promise<SyncOutcome> {
  const event = delivery.event;
  const p = Comment.safeParse(delivery.payload);
  if (!p.success || p.data.issue.pull_request === undefined)
    return { event, action: "ignored", detail: "not a pull request comment" };
  if (!isQaCommand(p.data.comment.body))
    return { event, action: "ignored", detail: "not a command" };
  const changeId = changeIdFor(p.data.repository.id, p.data.issue.number);
  const change = await deps.ports.store.getChange(changeId);
  if (change?.host == null) return { event, action: "ignored", detail: "unknown change" };
  const out = await askForQa(deps, {
    event,
    changeId,
    account: p.data.comment.user,
    via: "github-comment",
  });
  if (out.action === "recorded" && deps.host.publisher !== null) {
    // A quiet acknowledgement instead of a reply: 👀 on the command (best effort).
    await deps.host.publisher.react(p.data.comment.id, "eyes").catch(() => undefined);
  }
  return out;
}
