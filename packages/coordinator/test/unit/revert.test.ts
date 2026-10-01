import type { ChangeDiff } from "@app/domain";
import { describe, expect, it } from "vitest";
import { diffFiles, portsForRole } from "../../src/fakes/index.js";
import { revertIdFor } from "../../src/ids.js";
import { isInverseDiff, openRevertChange, verifyPureRevert } from "../../src/revert.js";
import { reload, type Scenario, scenario, startAndPush } from "./helpers.js";

async function merged(s: Scenario, changes: Record<string, string | null>) {
  const started = await startAndPush(s, changes);
  await s.coordinator.submitReview(s.reviewer, started.change.id, { decision: "approve" });
  await s.settle();
  return reload(s, started.change.id);
}

describe("openRevertChange", () => {
  it("main == merged sha: commits the pre-merge tree on a fresh fork (pure inverse) and starts it", async () => {
    const s = await scenario();
    const original = await merged(s, {
      "src/a.ts": "export const a = 2;\n",
      "src/new.ts": "new\n",
    });
    const result = await openRevertChange(
      { ports: portsForRole(s.ports, "default"), bindings: s.bindings },
      { original, reason: "error rate up" },
    );
    expect(result.method).toBe("tree");
    const revert = result.change;
    expect(revert).toMatchObject({
      id: revertIdFor(original.id),
      revertOf: original.id,
      planId: null,
      authorId: "system",
      claim: { category: "revert", summary: "error rate up" },
      baseSha: original.mergedSha,
    });
    const head = revert.headSha ?? "";
    const pre = s.ports.git.commits.get(original.mergedSha ?? "")?.parents[0] ?? "";
    expect(s.ports.git.commits.get(head)?.tree).toBe(s.ports.git.commits.get(pre)?.tree);
    expect(s.ports.git.commits.get(head)?.message).toContain(
      `This reverts commit ${original.mergedSha}`,
    );
    expect((await reload(s, original.id)).revertedBy).toBe(revert.id);
    expect(
      await verifyPureRevert(s.ports.git, {
        repo: revert.forkName,
        baseSha: revert.baseSha,
        headSha: head,
        mergedSha: original.mergedSha ?? "",
      }),
    ).toBe(true);
    // Idempotent: a retried step gets the same change back.
    const again = await openRevertChange(
      { ports: portsForRole(s.ports, "default"), bindings: s.bindings },
      { original, reason: "retry" },
    );
    expect(again).toMatchObject({ method: "existing", change: { id: revert.id } });
  });

  it("main moved past the merge: reverts in the sandbox, still verified as the inverse", async () => {
    const s = await scenario();
    const original = await merged(s, { "src/a.ts": "export const a = 2;\n" });
    await merged(s, { "src/b.ts": "b\n" });
    const result = await openRevertChange(
      { ports: portsForRole(s.ports, "default"), bindings: s.bindings },
      { original, reason: "kill" },
    );
    expect(result.method).toBe("sandbox");
    expect(s.ports.sandbox.calls.map((c) => c.op)).toContain("revert");
    const revert = result.change;
    expect(s.ports.git.filesAt(revert.headSha ?? "")).toMatchObject({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "b\n",
    });
    expect(
      await verifyPureRevert(s.ports.git, {
        repo: revert.forkName,
        baseSha: revert.baseSha,
        headSha: revert.headSha ?? "",
        mergedSha: original.mergedSha ?? "",
      }),
    ).toBe(true);
  });

  it("a conflicting revert opens the change for a human and notifies", async () => {
    const s = await scenario();
    const original = await merged(s, { "src/a.ts": "export const a = 2;\n" });
    await merged(s, { "src/a.ts": "export const a = 3;\n" });
    const result = await openRevertChange(
      { ports: portsForRole(s.ports, "default"), bindings: s.bindings },
      { original, reason: "kill" },
    );
    expect(result).toMatchObject({ method: "conflict", conflictFiles: ["src/a.ts"] });
    expect(result.change.status).toBe("awaiting-push");
    expect(s.ports.notifier.kinds(result.change.id)).toContain("failing");
  });
});

describe("isInverseDiff / verifyPureRevert", () => {
  const files = { "a.txt": "1\n2\n3\n", "b.txt": "x\n" };
  const after = { "a.txt": "1\nTWO\n3\n", "c.txt": "new\n" };
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const forward = diffFiles(A, B, files, after);

  it("accepts the exact inverse", () => {
    expect(isInverseDiff(forward, diffFiles(B, A, after, files))).toBe(true);
  });

  const cases: Array<[string, ChangeDiff]> = [
    ["an extra file", diffFiles(B, A, after, { ...files, "extra.txt": "!" })],
    ["a different line", diffFiles(B, A, after, { ...files, "a.txt": "1\n2\n3!\n" })],
    ["a partial revert", diffFiles(B, A, after, { ...after, "a.txt": files["a.txt"] })],
    ["the same diff again (not inverse)", forward],
    ["an empty diff", diffFiles(B, B, after, after)],
  ];
  it.each(cases)("rejects %s", (_name, backward) => {
    expect(isInverseDiff(forward, backward)).toBe(false);
  });

  it("rejects truncated or binary files (cannot prove)", () => {
    const back = diffFiles(B, A, after, files);
    const truncated = {
      ...back,
      files: back.files.map((f) => ({ ...f, truncated: true, hunks: [] })),
    };
    expect(isInverseDiff(forward, truncated)).toBe(false);
  });

  it("a revert that also sneaks in a change is not verified (and so never auto-merges)", async () => {
    const s = await scenario();
    const original = await merged(s, { "src/a.ts": "export const a = 2;\n" });
    const pre = s.ports.git.commits.get(original.mergedSha ?? "")?.parents[0] ?? "";
    await s.ports.git.forkRepo(s.repo.artifactsName, "task-sneaky");
    const sneaky = s.ports.git.commit("task-sneaky", "main", {
      ...s.ports.git.filesAt(pre),
      "src/evil.ts": "steal()\n",
    });
    expect(
      await verifyPureRevert(s.ports.git, {
        repo: "task-sneaky",
        baseSha: original.mergedSha ?? "",
        headSha: sneaky,
        mergedSha: original.mergedSha ?? "",
      }),
    ).toBe(false);
  });
});
