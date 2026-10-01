/** Repos created with an initial commit, and their bootstrap Change (first CI run + preview). */
import { describe, expect, it } from "vitest";
import { CoordinatorError, type InitialCommitProvider } from "../../src/api.js";
import { createFakeEnvironment, principal } from "../../src/fakes/index.js";
import { bootstrapChangeIdFor, changeWorkflowId } from "../../src/ids.js";
import { SYSTEM_PRINCIPAL_ID } from "../../src/ports.js";

const provider: InitialCommitProvider = async (input) => {
  if (input.template !== null && input.template !== "workers-api") {
    throw new CoordinatorError("invalid-input", `unknown template ${input.template}`, "Pick one.");
  }
  return {
    files: {
      "README.md": `# ${input.name}\n`,
      "AGENTS.md": `repo ${input.repoId}\n`,
      ".platform/policy.ts": "export default {};\n",
    },
    message: "Initial commit",
    policy: { previewRoutes: ["/"] },
  };
};

function env() {
  return createFakeEnvironment({ coordinator: { initialCommit: provider } });
}

describe("createRepo with an initial commit", () => {
  it("writes the provider's files as the first commit and caches the generated policy", async () => {
    const e = env();
    const human = principal({ kind: "human" });
    const repo = await e.coordinator.createRepo(human, { name: "api", template: "workers-api" });
    const head = e.ports.git.head("api");
    expect(head).not.toBeNull();
    expect(e.ports.git.filesAt(head as string)).toEqual({
      "README.md": "# api\n",
      "AGENTS.md": `repo ${repo.id}\n`,
      ".platform/policy.ts": "export default {};\n",
    });
    // The first change needs no policy sandbox job: the policy is cached for the initial sha.
    expect(repo).toMatchObject({ policySha: head, template: "workers-api" });
    expect(repo.policy).toMatchObject({ previewRoutes: ["/"], lane0Enabled: false });
    // Written create-only by the default (fork-only) role.
    expect(e.ports.git.writes).toEqual([
      { op: "initial-commit", repo: "api", ref: "refs/heads/main" },
    ]);
  });

  it("fails an unknown template before creating anything", async () => {
    const e = env();
    const human = principal({ kind: "human" });
    await expect(e.coordinator.createRepo(human, { name: "xy", template: "nope" })).rejects.toThrow(
      /unknown template/,
    );
    expect(e.ports.git.repos.has("xy")).toBe(false);
  });

  it("is idempotent per (actor, key) and adopts its own empty repo after a partial failure", async () => {
    const e = env();
    const human = principal({ kind: "human" });
    const a = await e.coordinator.createRepo(human, { name: "idem", idempotencyKey: "k1" });
    const b = await e.coordinator.createRepo(human, { name: "idem", idempotencyKey: "k1" });
    expect(b.id).toBe(a.id);
    await expect(
      e.coordinator.createRepo(human, { name: "other", idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ code: "conflict" });
    // An empty Artifacts repo without a row (the first attempt died after create): adopted.
    await e.ports.git.createRepo("orphan", { defaultBranch: "main" });
    const adopted = await e.coordinator.createRepo(human, { name: "orphan" });
    expect(e.ports.git.head("orphan")).not.toBeNull();
    expect(adopted.artifactsName).toBe("orphan");
    // One with history is not.
    e.ports.git.seed("taken", { "a.txt": "a" });
    await expect(e.coordinator.createRepo(human, { name: "taken" })).rejects.toMatchObject({
      code: "upstream",
    });
  });

  it("reserves the seed- prefix for template caches", async () => {
    const e = env();
    await expect(
      e.coordinator.createRepo(principal({ kind: "human" }), { name: "seed-workers-api" }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });
});

describe("bootstrap change", () => {
  it("runs CI on the initial commit with no evidence steps, seals evidence and is released", async () => {
    const e = env();
    const human = principal({ kind: "human" });
    e.ports.store.addPrincipal(human);
    const repo = await e.coordinator.createRepo(human, { name: "boot", template: "workers-api" });
    const head = e.ports.git.head("boot") as string;
    const started = await e.coordinator.startBootstrapChange(human, repo.id);
    expect(started).toMatchObject({
      id: bootstrapChangeIdFor(repo.id),
      authorId: SYSTEM_PRINCIPAL_ID,
      baseSha: head,
      headSha: head,
      forkName: "boot",
      status: "running",
      claim: { category: "chore" },
    });
    const waiting = e.coordinator.waitFor(human, started.id, "evidence_ready", 60_000);
    await e.settle();
    expect((await waiting).reached).toBe(true);

    const done = await e.ports.store.getChange(started.id);
    expect(done).toMatchObject({ status: "released", mergedSha: head, lane: null, tourId: null });
    expect(done?.evidenceId).not.toBeNull();
    // CI ran on the main repo at the initial commit, without evidence steps; no fork was made.
    expect(e.ports.ci.starts).toHaveLength(1);
    expect(e.ports.ci.starts[0]).toMatchObject({
      artifactsRepo: "boot",
      baseSha: head,
      headSha: head,
      evidenceSteps: [],
    });
    expect([...e.ports.git.repos.keys()]).toEqual(["boot"]);
    // No sandbox policy job (cached), no judge or tour, nothing written to main but the commit.
    expect(e.ports.sandbox.calls.filter((c) => c.op === "policy")).toHaveLength(0);
    expect(e.ports.reviewer.judgeCalls).toHaveLength(0);
    expect(e.ports.reviewer.tourCalls).toHaveLength(0);
    expect(e.ports.git.writes.map((w) => w.op)).toEqual(["initial-commit"]);

    // Lane and tour milestones are unreachable, merged is reached (the commit is on main).
    expect((await e.coordinator.waitFor(human, started.id, "lane_assigned", 1)).reason).toBe(
      "unreachable",
    );
    expect((await e.coordinator.waitFor(human, started.id, "tour_ready", 1)).reason).toBe(
      "unreachable",
    );
    expect((await e.coordinator.waitFor(human, started.id, "merged", 1)).reached).toBe(true);
    expect(e.ports.audit.actions()).toEqual(
      expect.arrayContaining(["change.bootstrap-started", "change.bootstrap-released"]),
    );
  });

  it("is idempotent, owner-only, and cannot be killed", async () => {
    const e = env();
    const human = principal({ kind: "human" });
    const stranger = principal({ kind: "human" });
    e.ports.store.addPrincipal(human);
    const repo = await e.coordinator.createRepo(human, { name: "twice" });
    const a = await e.coordinator.startBootstrapChange(human, repo.id);
    const b = await e.coordinator.startBootstrapChange(human, repo.id);
    expect(b.id).toBe(a.id);
    await e.settle();
    expect(e.bindings.changeWorkflow.instances.has(changeWorkflowId(a.id, a.baseSha))).toBe(true);
    expect(e.ports.ci.starts).toHaveLength(1);
    await expect(e.coordinator.startBootstrapChange(stranger, repo.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(e.coordinator.kill(human, a.id, "no")).rejects.toMatchObject({
      code: "invalid-state",
    });
  });

  it("stays failing (not released) when the first CI run fails", async () => {
    const e = env();
    const human = principal({ kind: "human" });
    e.ports.store.addPrincipal(human);
    e.ports.ci.outcome = () => ({ status: "failed", evidence: [] });
    const repo = await e.coordinator.createRepo(human, { name: "red" });
    const change = await e.coordinator.startBootstrapChange(human, repo.id);
    await e.settle();
    expect(await e.ports.store.getChange(change.id)).toMatchObject({
      status: "failing",
      mergedSha: null,
    });
  });
});
