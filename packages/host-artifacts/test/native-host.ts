/**
 * The native host for the contract suite: the whole coordinator in memory (fake ports, the real
 * ChangeCoordinator, ChangeWorkflow and merge queue cores), driven through its real event path:
 * a push to the change fork → `onPush` → ChangeWorkflow → `@app/core` `gradeChange`.
 */

import {
  createFakeEnvironment,
  type FakeEnvironment,
  portsForRole,
  principal,
} from "@app/coordinator/fakes";
import type { GradeReviewer } from "@app/core";
import type { Change, Principal } from "@app/domain";
import type { ChangeRef, LaneAction } from "@app/host";
import type {
  ContractHost,
  ContractHostFactory,
  ContractReviewer,
  ContractScenario,
  Observed,
  OpenInput,
} from "@app/host-contract";
import { ArtifactsHost, nativeRef } from "../src/index.js";

const BRANCH_REF = "refs/heads/main";

/** What the native host did with the head it graded, read off the Change row. */
function actionOf(status: Change["status"]): LaneAction | null {
  if (status === "awaiting-review") return "request-review";
  if (status === "failing") return "blocked";
  if (["queued", "merged", "rolling-out", "released"].includes(status)) return "merge";
  return null;
}

export class NativeContractHost implements ContractHost {
  readonly env: FakeEnvironment = createFakeEnvironment();
  readonly adapter: ArtifactsHost;
  private ciItems: ContractScenario["ciItems"] | null = null;
  private agent: Principal | null = null;
  private owner: Principal | null = null;

  constructor(reviewer: GradeReviewer) {
    const { ports, bindings } = this.env;
    // The host grades with the suite's reviewer (one shared instance across every role's ports).
    ports.reviewer.judge = (input) => reviewer.judge(input);
    ports.reviewer.tour = (input) => reviewer.tour(input);
    ports.ci.outcome = (req) => ({
      status: "passed",
      evidence: this.ciItems?.({ baseSha: req.baseSha, headSha: req.headSha }) ?? [],
      bundleRef: `bundle/${req.runId}`,
    });
    this.adapter = new ArtifactsHost({ ports: portsForRole(ports, "default"), bindings });
  }

  async open({ scenario, base, push, title }: OpenInput) {
    const { env } = this;
    this.ciItems = scenario.ciItems;
    const repo = await env.seedRepo({ files: base, policy: scenario.policy });
    const owner = env.ports.store.addPrincipal(principal({ kind: "human" }));
    this.owner = owner;
    this.agent = env.ports.store.addPrincipal(principal({ kind: "agent", ownerId: owner.id }));
    const planId = scenario.plan === null ? null : `plan-${repo.id}`;
    if (scenario.plan !== null && planId !== null) {
      env.ports.store.addPlan({ ...scenario.plan, id: planId, repoId: repo.id });
    }
    const { change } = await env.coordinator.startChange(this.agent, {
      repoId: repo.id,
      ...(planId === null ? {} : { planId }),
      title: title.slice(0, 200),
      category: scenario.category,
      summary: "the author's own summary (never shown to the reviewer agent)",
    });
    const headSha = await this.pushTo(change, push, false);
    return { ref: nativeRef(change), headSha };
  }

  private async change(ref: ChangeRef): Promise<Change> {
    if (ref.host !== "artifacts") throw new Error("not a native ref");
    const change = await this.env.ports.store.getChange(ref.changeId);
    if (change === null) throw new Error(`change ${ref.changeId} missing`);
    return change;
  }

  /** An agent's `git push` to its fork, then the Artifacts push event. */
  private async pushTo(
    change: Change,
    changes: Record<string, string | null>,
    force: boolean,
  ): Promise<string> {
    const { git } = this.env.ports;
    const refs = git.repo(change.forkName).refs;
    const before = refs.get(BRANCH_REF) ?? change.baseSha;
    if (force) refs.set(BRANCH_REF, change.baseSha);
    const after = git.commit(change.forkName, "main", changes, force ? "force push" : "push");
    await this.env.coordinator.onPush({
      repoName: change.forkName,
      ref: BRANCH_REF,
      before,
      after,
    });
    return after;
  }

  async push(ref: ChangeRef, changes: Record<string, string | null>, opts: { force: boolean }) {
    return this.pushTo(await this.change(ref), changes, opts.force);
  }

  async holdRuns(hold: boolean) {
    const { ci } = this.env.ports;
    ci.autoFinish = !hold;
    if (hold) return;
    for (const [runId, run] of ci.runs) {
      if (run.status.status === "running") await ci.finish(runId);
    }
  }

  settle() {
    return this.env.settle();
  }

  async observe(ref: ChangeRef, headSha: string): Promise<Observed> {
    const { store, signer, ci } = this.env.ports;
    const change = await this.change(ref);
    const [cls, evidence] = await Promise.all([
      store.getClassification(change.id, headSha),
      store.getEvidence(change.id, headSha),
    ]);
    const tour =
      [...store.tours.values()].find((t) => t.changeId === change.id && t.headSha === headSha) ??
      null;
    const runs = [...ci.runs.values()].filter(
      (r) => r.request.changeId === change.id && r.request.headSha === headSha,
    );
    return {
      verdict:
        cls === null
          ? null
          : {
              headSha,
              lane: cls.lane,
              computedLane: cls.computedLane,
              shadow: cls.shadow,
              blocked: cls.blocked,
              requiresHumanApproval: cls.requiresHumanApproval,
              reasons: cls.reasons.map((r) => r.code),
            },
      action: change.headSha === headSha ? actionOf(change.status) : null,
      evidence:
        evidence === null
          ? null
          : {
              kinds: [...new Set(evidence.items.map((i) => i.kind))].sort(),
              verified: (await signer.verifyEvidence(evidence)).ok,
            },
      tour,
      run: runs.at(-1)?.status.status ?? null,
      approved: [...store.reviews.values()].some(
        (r) => r.changeId === change.id && r.headSha === headSha && r.decision === "approve",
      ),
    };
  }

  /** Natively: the platform's review API (humans only; the author is the change's agent). */
  async review(ref: ChangeRef, headSha: string, who: ContractReviewer): Promise<void> {
    const change = await this.change(ref);
    const { store } = this.env.ports;
    const actor =
      who === "maintainer"
        ? (this.maintainer ??= store.addPrincipal(principal({ kind: "human" })))
        : who === "author"
          ? await store.getPrincipal(change.authorId)
          : store.addPrincipal(principal({ kind: "agent", ownerId: this.owner?.id ?? null }));
    if (actor === null) return;
    try {
      await this.env.coordinator.submitReview(actor, change.id, { decision: "approve", headSha });
    } catch {
      // refused: not counted
    }
    await this.env.settle();
  }
  private maintainer: Principal | null = null;

  async verdictHeads(ref: ChangeRef): Promise<string[]> {
    const change = await this.change(ref);
    const { audit } = this.env.ports;
    return audit.events.flatMap((e, i) =>
      e.subject === `change:${change.id}` && e.action === "change.classified"
        ? [(audit.payloads[i] as { headSha: string }).headSha]
        : [],
    );
  }
}

export const nativeContractHost: ContractHostFactory = {
  name: "artifacts (in-memory fakes)",
  create: async ({ reviewer }) => new NativeContractHost(reviewer),
};
