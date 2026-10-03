/**
 * create_project opens the caller's first Change as "First change"; its first push renames it
 * (journey 10/11: the placeholder never changed, so every project's list said "First change").
 */
import { describe, expect, it } from "vitest";
import { PLACEHOLDER_CHANGE_TITLE, titleFromCommitMessage } from "../../src/lifecycle.js";
import { reload, scenario } from "./helpers.js";

async function firstChange(s: Awaited<ReturnType<typeof scenario>>, planId?: string) {
  const { change } = await s.coordinator.startChange(s.agent, {
    repoId: s.repo.id,
    title: PLACEHOLDER_CHANGE_TITLE,
    category: "feature",
    ...(planId === undefined ? {} : { planId }),
  });
  return change;
}

async function pushWith(s: Awaited<ReturnType<typeof scenario>>, id: string, message: string) {
  const change = await reload(s, id);
  const head = s.ports.git.commit(change.forkName, "main", { "src/t.ts": `// ${message}\n` }, message);
  await s.coordinator.onPush({
    repoName: change.forkName,
    ref: "refs/heads/main",
    before: change.headSha ?? change.baseSha,
    after: head,
  });
  await s.settle();
  return reload(s, id);
}

describe("the first Change's placeholder title", () => {
  it("becomes the pushed commit's subject, once", async () => {
    const s = await scenario();
    const change = await firstChange(s);
    const pushed = await pushWith(s, change.id, "Add a /time endpoint\n\nReturns the current time.");
    expect(pushed.title).toBe("Add a /time endpoint");
    expect(s.ports.audit.payloadOf("change.pushed")).toMatchObject({ title: "Add a /time endpoint" });
    // A later push keeps it: only the placeholder is ever replaced.
    expect((await pushWith(s, change.id, "fix typo")).title).toBe("Add a /time endpoint");
  });

  it("takes the Plan's title when the Change has one", async () => {
    const s = await scenario();
    const change = await firstChange(s, `plan-${s.repo.id}`);
    const plan = await s.ports.store.getPlan(`plan-${s.repo.id}`);
    expect((await pushWith(s, change.id, "wip")).title).toBe(plan?.title);
  });

  it("a Change someone titled is never renamed", async () => {
    const s = await scenario();
    const { change } = await s.coordinator.startChange(s.agent, {
      repoId: s.repo.id,
      title: "Rate limit logins",
      category: "feature",
    });
    expect((await pushWith(s, change.id, "Something else")).title).toBe("Rate limit logins");
  });

  it("subjects: first non-empty line, trimmed, at most 200 characters", () => {
    expect(titleFromCommitMessage("\n  Fix the clock  \nbody")).toBe("Fix the clock");
    expect(titleFromCommitMessage("   \n")).toBeNull();
    expect(titleFromCommitMessage(null)).toBeNull();
    expect(titleFromCommitMessage("x".repeat(300))?.length).toBe(200);
  });
});
