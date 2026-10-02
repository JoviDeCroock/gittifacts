/**
 * The owner's Lane 0 toggle against the `.platform/policy.ts` that @app/conventions generates for
 * every new repo. The generated file must not say `lane0Enabled: false`: a file that does forces
 * Lane 0 off, so every default-branch commit (which re-reads the policy) would undo the toggle.
 */
import type { ReviewDecision } from "@app/domain";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { defaultPolicyTs } from "../../../conventions/src/index.js";
import { resolvePolicy } from "../../src/policy.js";
import { type Scenario, scenario, startAndPush } from "./helpers.js";

/** Transpiles a `.platform/*.ts` file and imports it, as the sandbox evaluates it. */
async function evaluate(text: string): Promise<unknown> {
  const js = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = (await import(`data:text/javascript;base64,${btoa(js)}`)) as { default: unknown };
  return mod.default;
}

/** 25 agreeing human reviews of Lane-0 candidates: enough for `setLane0(true)`. */
async function earnShadowAgreement(s: Scenario): Promise<void> {
  const { change } = await startAndPush(s);
  for (let i = 0; i < 25; i++) {
    await s.ports.store.insertChange({ ...change, id: `c-${i}`, forkName: `task-c-${i}` });
    const review: ReviewDecision = {
      id: `rev-${i}`,
      changeId: `c-${i}`,
      headSha: "a".repeat(40),
      reviewerId: s.reviewer.id,
      decision: "approve",
      humanLane: null,
      computedLane: 0,
      comment: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    await s.ports.store.putReview(review);
  }
}

async function repoPolicy(s: Scenario) {
  const repo = await s.ports.store.getRepo(s.repo.id);
  if (repo === null) throw new Error("repo vanished");
  return { policy: repo.policy, policySha: repo.policySha, repo };
}

describe("Lane 0 toggle with the generated policy file", () => {
  it("an owner's toggle survives later default-branch commits", async () => {
    const s = await scenario();
    const generated = defaultPolicyTs({ previewRoutes: ["/"] });
    s.ports.git.commit(s.repo.artifactsName, "main", { [generated.path]: generated.text });
    s.ports.sandbox.policies.set(s.repo.artifactsName, await evaluate(generated.text));
    await earnShadowAgreement(s);

    expect((await s.coordinator.setLane0(s.reviewer, s.repo.id, true)).policy.lane0Enabled).toBe(
      true,
    );

    // A later commit lands on main; the next Change reads the policy at that new base.
    const head = s.ports.git.commit(s.repo.artifactsName, "main", { "README.md": "# v2\n" });
    await startAndPush(s);
    const after = await repoPolicy(s);
    expect(after.policySha).toBe(head); // the file was evaluated again, not served from cache
    expect(after.policy.lane0Enabled).toBe(true);

    // And again, resolving directly at another default-branch head.
    const next = s.ports.git.commit(s.repo.artifactsName, "main", { "README.md": "# v3\n" });
    const resolved = await resolvePolicy(s.ports, {
      repo: after.repo,
      repoName: s.repo.artifactsName,
      sha: next,
    });
    expect(resolved).toMatchObject({ source: "file", policy: { lane0Enabled: true } });
    expect((await repoPolicy(s)).policy.lane0Enabled).toBe(true);
  });

  it("a policy file can still force Lane 0 off, but never on", async () => {
    const s = await scenario();
    await earnShadowAgreement(s);
    await s.coordinator.setLane0(s.reviewer, s.repo.id, true);
    const { repo } = await repoPolicy(s);
    const at = (files: Record<string, string>) =>
      s.ports.git.commit(s.repo.artifactsName, "main", files);

    s.ports.sandbox.policies.set(s.repo.artifactsName, { lane0Enabled: false });
    const off = await resolvePolicy(s.ports, {
      repo,
      repoName: s.repo.artifactsName,
      sha: at({ "a.txt": "1" }),
      cache: false,
    });
    expect(off.policy.lane0Enabled).toBe(false);

    const disabled = { ...repo, policy: { ...repo.policy, lane0Enabled: false } };
    s.ports.sandbox.policies.set(s.repo.artifactsName, { lane0Enabled: true });
    const on = await resolvePolicy(s.ports, {
      repo: disabled,
      repoName: s.repo.artifactsName,
      sha: at({ "a.txt": "2" }),
      cache: false,
    });
    expect(on.policy.lane0Enabled).toBe(false);
  });
});
