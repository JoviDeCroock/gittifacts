/**
 * The templates' global CI cache is re-seeded once per worker version: the cache key includes the
 * runner image (rebuilt by most deploys), and the engine keys seed runs by the seed commit's sha,
 * so each new version gets one new seed commit per template and one seed run.
 */
import type { CiEngine } from "@app/ci-engine";
import { TEMPLATE_IDS } from "@app/conventions";
import { FakeGitHost } from "@app/coordinator/fakes";
import { describe, expect, it } from "vitest";
import { seedRepoName } from "../src/projects/seed-cache.js";
import { seedOnDeploy } from "../src/projects/seed-on-deploy.js";

function deps(version: string | null) {
  const git = new FakeGitHost();
  const seeds: { templateId: string; sha: string }[] = [];
  const engine = {
    seedCache: async (input: { templateId: string; sha: string }) => {
      seeds.push({ templateId: input.templateId, sha: input.sha });
      return { runId: `seed-${input.templateId}-${input.sha.slice(0, 8)}` };
    },
  } as unknown as CiEngine;
  let marker: { version: string; seededAt: string } | null = null;
  return {
    git,
    seeds,
    get marker() {
      return marker;
    },
    deps: {
      version,
      origin: "https://gittifacts.example",
      marker: {
        get: async () => marker,
        put: async (m: { version: string; seededAt: string }) => {
          marker = m;
        },
      },
      git,
      engine,
      now: () => new Date("2026-10-03T12:00:00Z"),
    },
  };
}

describe("seedOnDeploy", () => {
  it("seeds every template once per worker version, with a new seed commit for a new version", async () => {
    const t = deps("v1");
    const first = await seedOnDeploy(t.deps);
    expect(first.action).toBe("seeded");
    expect(t.seeds.map((s) => s.templateId).sort()).toEqual([...TEMPLATE_IDS].sort());
    expect(t.marker?.version).toBe("v1");
    // Same version again (the next cron run): nothing to do.
    expect(await seedOnDeploy(t.deps)).toEqual({ action: "current", version: "v1" });
    expect(t.seeds).toHaveLength(TEMPLATE_IDS.length);

    // A deploy: every seed repo gets a new commit (same tree), so the engine seeds again.
    const before = new Map(t.seeds.map((s) => [s.templateId, s.sha]));
    const next = await seedOnDeploy({ ...t.deps, version: "v2" });
    expect(next.action).toBe("seeded");
    const second = t.seeds.slice(TEMPLATE_IDS.length);
    expect(second).toHaveLength(TEMPLATE_IDS.length);
    for (const s of second) {
      expect(s.sha).not.toBe(before.get(s.templateId));
      const repo = seedRepoName(s.templateId as (typeof TEMPLATE_IDS)[number]);
      expect(await t.git.commitParents(repo, s.sha)).toEqual([before.get(s.templateId)]);
      expect(await t.git.treeOf(repo, s.sha)).toBe(
        await t.git.treeOf(repo, before.get(s.templateId) ?? ""),
      );
    }
    expect(t.marker?.version).toBe("v2");
  });

  it("a failed template leaves the marker unset; a retry reuses the version's seed commit", async () => {
    const t = deps("v1");
    await seedOnDeploy(t.deps); // seed repos exist for v1
    const failing = deps("v2");
    // Same repos, an engine that fails one template.
    const calls: string[] = [];
    const engine = {
      seedCache: async (input: { templateId: string; sha: string }) => {
        calls.push(`${input.templateId}@${input.sha}`);
        if (input.templateId === TEMPLATE_IDS[0]) throw new Error("engine busy");
        return { runId: "r" };
      },
    } as unknown as CiEngine;
    const once = await seedOnDeploy({ ...failing.deps, git: t.git, engine });
    expect(once.action).toBe("seeded");
    expect(failing.marker).toBeNull();
    await seedOnDeploy({ ...failing.deps, git: t.git, engine });
    // The retry seeds the same commits (no second commit for the same version).
    expect(calls.slice(TEMPLATE_IDS.length).sort()).toEqual(calls.slice(0, TEMPLATE_IDS.length).sort());
  });

  it("does nothing without version metadata", async () => {
    const t = deps(null);
    expect((await seedOnDeploy(t.deps)).action).toBe("skipped");
    expect(t.seeds).toHaveLength(0);
  });
});
