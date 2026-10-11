/**
 * The backtest end to end on the recorded-fixture host: merged PRs listed through GraphQL, each
 * graded by the real ChangeWorkflow as a backtest Change (what landed: the merge commit against
 * its parent), reverts and 14-day patches correlated on the mirror, and nothing written to GitHub.
 */
import { portsForRole, principal } from "@app/coordinator/fakes";
import { contractReviewer, loadFixture } from "@app/host-contract";
import { describe, expect, it } from "vitest";
import { backtestChangeId, runBacktest } from "../src/backtest/runner.js";
import { principalIdFor } from "../src/ids.js";
import { gitName } from "./fake-github.js";
import { GithubContractHost } from "./github-host.js";

const day = (d: number) => new Date(Date.UTC(2026, 6, 1) + d * 86_400_000).toISOString();

describe("backtest (recorded fixtures)", () => {
  it("grades merged PRs through the ChangeWorkflow, finds the revert, writes nothing to GitHub", async () => {
    const host = new GithubContractHost(contractReviewer());
    const fx = loadFixture("pure-bugfix-with-regression-test");
    const { gh, env } = host;
    host.gh.seed(fx.base);
    const repo = await host.sync.ensureRepo(gh.repoJson() as never);
    const merge = (
      n: number,
      d: number,
      changes: Record<string, string | null>,
      extra: { title?: string; headRefName?: string } = {},
    ) => {
      const sha = gh.git.commit(gitName(gh.repo), "main", changes, `#${n}`);
      gh.merged.push({
        number: n,
        title: extra.title ?? `PR ${n}`,
        body: null,
        createdAt: day(d - 0.2),
        mergedAt: day(d),
        headRefName: extra.headRefName ?? `feature-${n}`,
        author: { login: "octo-dev", id: 5150, type: "User" },
        mergeSha: sha,
        files: Object.keys(changes),
        labels: [],
      });
      return sha;
    };
    const file = "src/allocate.ts";
    const fixed = fx.head[file] ?? "";
    merge(1, 1, fx.push, { title: "fix: allocate() keeps the last cent" });
    merge(2, 3, {
      [file]: fixed.replace("index < leftover ? 1 : 0", "index <= leftover - 1 ? 1 : 0"),
    });
    merge(3, 5, { [file]: fixed }, { title: 'Revert "PR 2"', headRefName: "revert-2-feature-2" });
    merge(4, 30, { "README.md": "# fixture lib, again\n" });
    const writesBefore = gh.writes.length;

    const report = await runBacktest(
      {
        ports: portsForRole(env.ports, "github"),
        api: host.api,
        repo,
        coordinator: (id) => env.bindings.changeCoordinator(id),
        source: async () => ({
          remote: {
            url: `https://${gitName(gh.repo)}.git`,
            auth: { basic: { username: "x-access-token", password: "t" } },
          },
          release: async () => {},
        }),
        authorPrincipal: async (who) => {
          const id = principalIdFor(Number(who.id));
          if ((await env.ports.store.getPrincipal(id)) === null)
            env.ports.store.addPrincipal(
              principal({ id, kind: "human", name: `${who.login} (GitHub)` }),
            );
          return id;
        },
        step: (_name, run) => run(),
        sleep: () => host.settle(),
      },
      { since: day(0), until: day(60), wave: 2, pollMs: 0 },
    );

    expect(report).toMatchObject({ listed: 4, graded: 4, skipped: [], reverts: 1 });
    expect(report.lanes["0"] + report.lanes["1"] + report.lanes["2"]).toBe(4);
    for (const n of [1, 2, 3, 4]) {
      const c = await env.ports.store.getChange(backtestChangeId(9001, n));
      expect(c).toMatchObject({ status: "merged", host: { backtest: true, number: n } });
      expect(c?.mergedSha).toBe(c?.host?.mergedSha);
    }
    // History is graded quietly: no check runs, reviews or comments, and no tours.
    expect(gh.writes.slice(writesBefore)).toEqual([]);
    expect([...env.ports.store.tours.values()]).toEqual([]);
  });
});
