/**
 * Import detection → a `.platform` proposal (Plan + Change a human approves), started here and
 * run by `PlatformConfigWorkflow`.
 *
 * - `startPlatformConfigProposal(svc, input)`: start (or find) the proposal for the repo's current
 *   default-branch commit and return at once. `create_project({ from })` calls this right after
 *   the import.
 * - `proposePlatformConfig(svc, caller, input)`: the MCP tool / HTTP route; also waits up to
 *   `waitSec` for the proposal to finish.
 *
 * One proposal per (repo, default-branch commit) unless `rerun` asks for a fresh one. The latest
 * proposal id lives in the project's `ProjectLedger`.
 */
import { resolveRuntime } from "@app/coordinator";
import type { ProposalView } from "@app/mcp";
import type { Caller, Services } from "../app-env.js";
import { ApiError } from "../errors.js";
import { requireRepo } from "../services/changes.js";
import type { ProposalPointer } from "../workspace/ledger-do.js";
import type { ProposalOutput } from "./workflow.js";

/** The bindings the proposal needs (in the Worker's `Env` once wired). */
interface ImportBindings {
  PLATFORM_CONFIG_WORKFLOW: Workflow;
  PROJECT_LEDGER: DurableObjectNamespace<import("../workspace/ledger-do.js").ProjectLedger>;
}

function bindings(svc: Services): ImportBindings {
  return svc.env as unknown as ImportBindings;
}

export function proposalIdFor(repoId: string, sha: string, nonce: string): string {
  return `pcfg-${repoId}-${sha.slice(0, 12)}-${nonce}`.slice(0, 100);
}

export interface StartProposalInput {
  repoId: string;
  /** Who asked (audit); `system` when create_project starts it after an import. */
  requestedBy: string;
  rerun?: boolean;
}

/** Starts (or finds) the proposal for the repo's current default-branch commit. Returns at once. */
export async function startPlatformConfigProposal(
  svc: Services,
  input: StartProposalInput,
): Promise<{ pointer: ProposalPointer; started: boolean }> {
  const repo = await requireRepo(svc, input.repoId);
  const git = resolveRuntime(svc.env, "default").ports.git;
  const sha = await git.branchHead(repo.artifactsName, repo.defaultBranch);
  if (sha === null) {
    throw new ApiError(409, "invalid-state", `${repo.name} has no commits yet`, undefined, {
      explanation: "Detection inspects the default branch; push or import a commit first.",
    });
  }
  const ledger = bindings(svc).PROJECT_LEDGER.getByName(repo.id);
  const current = await ledger.getProposal();
  if (current !== null && current.baseSha === sha && input.rerun !== true) {
    return { pointer: current, started: false };
  }
  const nonce = svc.clock.now().getTime().toString(36);
  const pointer: ProposalPointer = {
    proposalId: proposalIdFor(repo.id, sha, nonce),
    baseSha: sha,
    startedAt: svc.clock.now().toISOString(),
    requestedBy: input.requestedBy,
  };
  await bindings(svc).PLATFORM_CONFIG_WORKFLOW.create({
    id: pointer.proposalId,
    params: {
      proposalId: pointer.proposalId,
      repoId: repo.id,
      requestedBy: input.requestedBy,
      host: svc.origin,
    },
  });
  await ledger.setProposal(pointer);
  await svc.audit.append({
    principalId: input.requestedBy,
    action: "repo.platform-config-requested",
    subject: `repo:${repo.id}`,
    payload: { proposalId: pointer.proposalId, baseSha: sha, rerun: input.rerun === true },
  });
  return { pointer, started: true };
}

/** The proposal's state, from its workflow instance. */
export async function proposalView(
  svc: Services,
  repoId: string,
  pointer: ProposalPointer,
): Promise<ProposalView> {
  const base: ProposalView = {
    proposalId: pointer.proposalId,
    repoId,
    status: "running",
    baseSha: pointer.baseSha,
    planId: null,
    changeId: null,
    detection: null,
    error: null,
    startedAt: pointer.startedAt,
  };
  let status: InstanceStatus;
  try {
    const instance = await bindings(svc).PLATFORM_CONFIG_WORKFLOW.get(pointer.proposalId);
    status = await instance.status();
  } catch (e) {
    return { ...base, status: "failed", error: `the proposal is gone: ${String(e)}` };
  }
  if (status.status === "errored" || status.status === "terminated") {
    const message = status.error?.message ?? status.status;
    return { ...base, status: "failed", error: message.slice(0, 2000) };
  }
  if (status.status !== "complete") return base;
  const out = status.output as ProposalOutput | undefined;
  if (out === undefined) return { ...base, status: "failed", error: "the proposal has no output" };
  return {
    ...base,
    status: out.notNeeded ? "not-needed" : "proposed",
    baseSha: out.baseSha,
    planId: out.planId,
    changeId: out.changeId,
    detection: out.detection,
  };
}

/** `propose_platform_config` / `POST /api/v1/repos/{repoId}/platform-config`. */
export async function proposePlatformConfig(
  svc: Services,
  caller: Caller,
  input: { repoId: string; rerun: boolean; waitSec: number },
): Promise<ProposalView> {
  const { pointer } = await startPlatformConfigProposal(svc, {
    repoId: input.repoId,
    requestedBy: caller.principal.id,
    rerun: input.rerun,
  });
  const deadline = Date.now() + input.waitSec * 1000;
  let view = await proposalView(svc, input.repoId, pointer);
  while (view.status === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    view = await proposalView(svc, input.repoId, pointer);
  }
  return view;
}

/** The latest proposal of a repo, without starting one (GET route). */
export async function latestProposal(svc: Services, repoId: string): Promise<ProposalView | null> {
  await requireRepo(svc, repoId);
  const pointer = await bindings(svc).PROJECT_LEDGER.getByName(repoId).getProposal();
  return pointer === null ? null : proposalView(svc, repoId, pointer);
}
