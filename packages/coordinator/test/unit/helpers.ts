import type { Change, Principal, Repo } from "@app/domain";
import {
  approvedPlan,
  createFakeEnvironment,
  type FakeEnvironment,
  principal,
} from "../../src/fakes/index.js";
import { changeWorkflowId } from "../../src/ids.js";

export interface Scenario extends FakeEnvironment {
  repo: Repo;
  agent: Principal;
  owner: Principal;
  reviewer: Principal;
}

/** A repo with an approved plan, an agent (owned by `owner`) and a separate human reviewer. */
export async function scenario(
  opts: Parameters<FakeEnvironment["seedRepo"]>[0] & {
    env?: Parameters<typeof createFakeEnvironment>[0];
  } = {},
): Promise<Scenario> {
  const env = createFakeEnvironment(opts.env);
  const repo = await env.seedRepo(opts);
  const owner = env.ports.store.addPrincipal(principal({ kind: "human" }));
  const agent = env.ports.store.addPrincipal(principal({ kind: "agent", ownerId: owner.id }));
  const reviewer = env.ports.store.addPrincipal(principal({ kind: "human" }));
  env.ports.store.addPlan(approvedPlan(repo.id));
  return { ...env, repo, agent, owner, reviewer };
}

/** Start a change as the agent and push `changes` to its fork; returns the change after CI etc. */
export async function startAndPush(
  s: Scenario,
  changes: Record<string, string | null> = { "src/a.ts": "export const a = 2;\n" },
  opts: { category?: Change["claim"]["category"]; planId?: string | null } = {},
): Promise<{ change: Change; headSha: string; instanceId: string }> {
  const { change } = await s.coordinator.startChange(s.agent, {
    repoId: s.repo.id,
    ...(opts.planId === null ? {} : { planId: opts.planId ?? `plan-${s.repo.id}` }),
    title: "Fix a",
    category: opts.category ?? "fix",
    summary: "the author's own summary (never shown to the reviewer agent)",
  });
  const headSha = push(s, change, changes);
  await s.coordinator.onPush({
    repoName: change.forkName,
    ref: "refs/heads/main",
    before: change.baseSha,
    after: headSha,
  });
  await s.settle();
  const fresh = await s.ports.store.getChange(change.id);
  if (fresh === null) throw new Error("change vanished");
  return { change: fresh, headSha, instanceId: changeWorkflowId(change.id, headSha) };
}

export function push(s: Scenario, change: Change, changes: Record<string, string | null>): string {
  return s.ports.git.commit(change.forkName, "main", changes, "agent commit");
}

export async function reload(s: Scenario, id: string): Promise<Change> {
  const c = await s.ports.store.getChange(id);
  if (c === null) throw new Error(`change ${id} missing`);
  return c;
}
