/**
 * The proposal's steps, independent of the Workflow class (./workflow.ts) so each one is a plain
 * async function. Every step is idempotent: the plan id derives from the proposal id, the Change
 * comes from `startChange` with the proposal id as idempotency key, and the commit step returns
 * the Change's head when it was already pushed.
 */
import { AGENTS_MD_PATH, type DetectReport } from "@app/conventions";
import {
  cloudflareBindings,
  createCoordinator,
  resolveRuntime,
  SYSTEM_PRINCIPAL_ID,
} from "@app/coordinator";
import { CI_PATH, type Plan, POLICY_PATH, type Principal } from "@app/domain";
import { sha256Hex } from "@app/evidence";
import { type Bindings, type Caller, createServices, type Services } from "../app-env.js";
import { facadeOptions } from "../coordinator.js";
import { requireRepo } from "../services/changes.js";
import { closeWorkspace, openWorkspace, wsCommitPush, wsWrite } from "../workspace/service.js";
import { importSandbox } from "./detect-job.js";
import { buildProposal, type ExistingFiles } from "./proposal.js";
import type { ProposalOutput, ProposalParams } from "./workflow.js";

export interface DetectSummary {
  confidence: "high" | "medium" | "low";
  packageManager: string;
  testRunner: string | null;
  workers: string[];
  uncertain: string[];
  buildScriptsNeedingApproval: string[];
}

export function summarize(r: DetectReport): DetectSummary {
  return {
    confidence: r.confidence,
    packageManager: r.packageManager,
    testRunner: r.testRunner,
    workers: r.workers,
    uncertain: r.uncertain,
    buildScriptsNeedingApproval: r.buildScriptsNeedingApproval.map((d) => d.name),
  };
}

export interface StepDeps {
  env: Bindings;
  ctx: ExecutionContext;
  params: ProposalParams;
  actorId: string;
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export function servicesFor(env: Bindings, ctx: ExecutionContext, origin: string): Services {
  return createServices(
    env,
    ctx,
    {
      coordinator: (e, _ctx, o) => {
        const rt = resolveRuntime(e, "default");
        return createCoordinator(rt.ports, rt.bindings ?? cloudflareBindings(e), facadeOptions(o));
      },
    },
    origin,
  );
}

export async function systemCaller(svc: Services): Promise<Caller> {
  const stored = await svc.store.getPrincipal(SYSTEM_PRINCIPAL_ID);
  const principal: Principal = stored ?? {
    id: SYSTEM_PRINCIPAL_ID,
    kind: "system",
    name: "gittifacts",
    ownerId: null,
    keys: [],
    scopes: [],
  };
  return { principal, user: null, via: "agent-token" };
}

/** Deterministic plan id per proposal (a retried step finds its plan). */
export async function planIdFor(proposalId: string): Promise<string> {
  return `plan_pcfg_${(await sha256Hex(`platform-config\u0000${proposalId}`)).slice(0, 24)}`;
}

const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

export async function runProposalSteps(d: StepDeps): Promise<ProposalOutput> {
  const svc = servicesFor(d.env, d.ctx, d.params.host);
  const git = resolveRuntime(d.env, "default").ports.git;
  const repo = await requireRepo(svc, d.params.repoId);

  const base = await d.step("base", async () => {
    const sha = await git.branchHead(repo.artifactsName, repo.defaultBranch);
    if (sha === null) throw new Error(`${repo.name} has no commits on ${repo.defaultBranch}`);
    const [ci, policy, agents] = await Promise.all([
      git.readFile(repo.artifactsName, sha, CI_PATH),
      git.readFile(repo.artifactsName, sha, POLICY_PATH),
      git.readFile(repo.artifactsName, sha, AGENTS_MD_PATH),
    ]);
    const existing: ExistingFiles = {
      ci: ci !== null,
      policy: policy !== null,
      agentsMd: text(agents),
    };
    return { sha, existing };
  });

  const report = await d.step("detect", () =>
    importSandbox(d.env).detect({
      repo: repo.artifactsName,
      remote: git.remoteOf(repo.artifactsName),
      sha: base.sha,
    }),
  );
  const proposal = buildProposal({ repo, report, existing: base.existing, host: d.params.host });
  const detection = summarize(report);
  if (Object.keys(proposal.files).length === 0) {
    return {
      baseSha: base.sha,
      planId: null,
      changeId: null,
      headSha: null,
      detection,
      notNeeded: true,
    };
  }
  const caller = await systemCaller(svc);

  const planId = await d.step("plan", async () => {
    const id = await planIdFor(d.params.proposalId);
    if ((await svc.store.getPlan(id)) !== null) return id;
    const plan: Plan = {
      ...proposal.plan,
      id,
      outOfScope: proposal.plan.outOfScope ?? [],
      riskDeclarations: proposal.plan.riskDeclarations ?? [],
      scopePaths: proposal.plan.scopePaths ?? [],
      affectedRoutes: proposal.plan.affectedRoutes ?? [],
      status: "draft",
      authorId: caller.principal.id,
      approvedBy: null,
      approvedAt: null,
      approvalSignature: null,
      supersedes: null,
      createdAt: svc.clock.now().toISOString(),
    };
    await svc.store.insertPlan(plan);
    await svc.audit.append({
      principalId: caller.principal.id,
      action: "plan.created",
      subject: `plan:${id}`,
      payload: {
        repoId: repo.id,
        title: plan.title,
        proposalId: d.params.proposalId,
        risks: plan.riskDeclarations.length,
      },
    });
    return id;
  });

  const changeId = await d.step("change", async () => {
    const { change } = await svc.coordinator.startChange(caller.principal, {
      repoId: repo.id,
      planId,
      title: proposal.changeTitle,
      category: "chore",
      summary: `Proposed by the platform from import detection (proposal ${d.params.proposalId}).`,
      idempotencyKey: d.params.proposalId,
    });
    return change.id;
  });

  const headSha = await d.step("commit", () => commitFiles(svc, caller, changeId, proposal));

  await d.step("record", async () => {
    await svc.audit.append({
      principalId: caller.principal.id,
      action: "repo.platform-config-proposed",
      subject: `repo:${repo.id}`,
      payload: {
        proposalId: d.params.proposalId,
        requestedBy: d.params.requestedBy,
        planId,
        changeId,
        headSha,
        baseSha: base.sha,
        confidence: report.confidence,
        uncertain: report.uncertain.length,
        files: Object.keys(proposal.files),
      },
    });
    return true;
  });
  return { baseSha: base.sha, planId, changeId, headSha, detection, notNeeded: false };
}

/** A system workspace writes the files and pushes them to the Change's fork (idempotent). */
async function commitFiles(
  svc: Services,
  caller: Caller,
  changeId: string,
  proposal: { files: Record<string, string>; commitMessage: string },
): Promise<string> {
  const change = await svc.store.getChange(changeId);
  if (change?.headSha) return change.headSha;
  let view = await openWorkspace(svc, caller, changeId, { waitMs: 120_000 });
  for (let i = 0; view.status === "starting" && i < 3; i++) {
    view = await openWorkspace(svc, caller, changeId, { waitMs: 120_000 });
  }
  const workspaceId = view.workspaceId;
  try {
    for (const [path, content] of Object.entries(proposal.files)) {
      await wsWrite(svc, caller, { workspaceId, path, content });
    }
    const pushed = await wsCommitPush(svc, caller, {
      workspaceId,
      message: proposal.commitMessage,
    });
    return pushed.commitSha;
  } finally {
    await closeWorkspace(svc, caller, workspaceId).catch(() => undefined);
  }
}
