import { describe, expect, it } from "vitest";
import { githubBacktests } from "../src/db/github-schema.js";
import { repoFixture, store } from "./fixtures.js";
import { callEnv } from "./github-helpers.js";
import { makeApp, signUpHuman } from "./http.js";

const host = (id: number) => ({ kind: "github" as const, owner: "acme", repo: `r${id}`, githubRepoId: id, installationId: 660000 + id, appId: 4242, private: true });

describe("backtests (M4)", () => {
  const { app } = makeApp();

  async function githubRepo() {
    const owner = await signUpHuman(app, "Owner");
    const id = 770000 + Math.floor(Math.random() * 10_000);
    const repo = repoFixture({ id: `gh-${id}`, name: `acme/r${id}`, artifactsName: `ghm-${id}`, host: host(id), claim: { status: "claimed", ownerId: owner.principal.id, expiresAt: null } });
    await store().insertRepo(repo);
    return { owner, repo, id };
  }

  it("owners start one backtest at a time; anyone who can read the repo sees the latest", async () => {
    const { owner, repo } = await githubRepo();
    const other = await signUpHuman(app, "Other");
    const denied = await callEnv(app, {}, "POST", `/api/v1/github/repos/${repo.id}/backtests`, { cookie: other.cookie, body: {} });
    expect([403, 404]).toContain(denied.status);
    const first = await callEnv(app, {}, "POST", `/api/v1/github/repos/${repo.id}/backtests`, { cookie: owner.cookie, body: { days: 60, maxPrs: 10 } });
    expect(first.status).toBe(202);
    const a = (await first.json()) as { id: string; started: boolean };
    expect(a.started).toBe(true);
    const again = (await (await callEnv(app, {}, "POST", `/api/v1/github/repos/${repo.id}/backtests`, { cookie: owner.cookie, body: {} })).json()) as { id: string; started: boolean };
    expect(again).toEqual({ id: a.id, started: false });
    const latest = (await (await callEnv(app, {}, "GET", `/api/v1/github/repos/${repo.id}/backtests/latest`, { cookie: owner.cookie })).json()) as { backtest: { id: string; maxPrs: number } };
    expect(latest.backtest).toMatchObject({ id: a.id, maxPrs: 10 });
  });

  it("Lane 0 stays off for a GitHub repo until a backtest found it calibrated", async () => {
    const { owner, repo, id } = await githubRepo();
    const refused = await callEnv(app, {}, "PATCH", `/api/v1/repos/${repo.id}/lane0`, { cookie: owner.cookie, body: { enabled: true }, headers: { "idempotency-key": `k-${id}-1` } });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("not-calibrated");
    const now = new Date().toISOString();
    await store().db.insert(githubBacktests).values({
      id: `bt-${id}-done`, repoId: repo.id, githubRepoId: id, installationId: host(id).installationId, status: "done",
      since: now, until: now, maxPrs: 24, report: { calibration: { reason: "30 Lane 0 candidates, 0 reverted or patched" } }, eligible: true,
      startedBy: "system", createdAt: new Date(Date.now() + 1000).toISOString(), finishedAt: now,
    });
    const allowed = await callEnv(app, {}, "PATCH", `/api/v1/repos/${repo.id}/lane0`, { cookie: owner.cookie, body: { enabled: true }, headers: { "idempotency-key": `k-${id}-2` } });
    // Past the calibration gate (the mocked coordinator answers whatever it answers, never not-calibrated).
    expect(((await allowed.json()) as { error?: { code: string } }).error?.code).not.toBe("not-calibrated");
  });
});
