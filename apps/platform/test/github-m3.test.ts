import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/app-env.js";
import { githubInstallationLinks } from "../src/db/github-schema.js";
import { githubActorPrincipal, upsertGithubPlan } from "../src/github/plans.js";
import { prWritesEnabled } from "../src/github/pr-index.js";
import { verifyPlanApproval } from "../src/services/plans.js";
import { platformSigner } from "../src/signing.js";
import { planFixture, repoFixture, seedPrincipal, store } from "./fixtures.js";
import { callEnv } from "./github-helpers.js";
import { makeApp, signUpHuman } from "./http.js";

const host = (id: number) => ({
  kind: "github" as const,
  owner: "acme",
  repo: `r${id}`,
  githubRepoId: id,
  installationId: 555000 + id,
  appId: 4242,
  private: true,
});

describe("PR writes switch (M3)", () => {
  const { app } = makeApp();

  it("is on once the installation is linked; an owner can turn it off, nobody else", async () => {
    const owner = await signUpHuman(app, "Owner");
    const other = await signUpHuman(app, "Other");
    const id = 880000 + Math.floor(Math.random() * 1000);
    const repo = repoFixture({
      id: `gh-${id}`,
      name: `acme/r${id}`,
      artifactsName: `ghm-${id}`,
      host: host(id),
      claim: { status: "claimed", ownerId: owner.principal.id, expiresAt: null },
    });
    await store().insertRepo(repo);
    expect(await prWritesEnabled(store().db, repo.id, host(id).installationId)).toBe(false); // not linked yet
    await store()
      .db.insert(githubInstallationLinks)
      .values({
        installationId: host(id).installationId,
        principalId: owner.principal.id,
        githubLogin: "owner-gh",
        linkedAt: new Date().toISOString(),
      });
    expect(await prWritesEnabled(store().db, repo.id, host(id).installationId)).toBe(true);
    const denied = await callEnv(app, {}, "PUT", `/api/v1/github/repos/${repo.id}/pr-writes`, {
      cookie: other.cookie,
      body: { value: "off" },
    });
    expect([403, 404]).toContain(denied.status);
    const ok = await callEnv(app, {}, "PUT", `/api/v1/github/repos/${repo.id}/pr-writes`, {
      cookie: owner.cookie,
      body: { value: "off" },
    });
    expect(ok.status).toBe(200);
    expect(await prWritesEnabled(store().db, repo.id, host(id).installationId)).toBe(false);
  });
});

describe("plans and people from GitHub (M3)", () => {
  it("an approved issue plan is signed by the platform and verifies like any approval", async () => {
    const s = store();
    const author = await seedPrincipal(s, { kind: "human" });
    const approver = await seedPrincipal(s, { kind: "human" });
    const repo = repoFixture();
    await s.insertRepo(repo);
    const plan = {
      ...planFixture(repo.id, author),
      id: `ghi-1-${Date.now()}`,
      status: "approved" as const,
      approvedBy: approver,
      approvedAt: new Date().toISOString(),
      approvalSignature: null,
    };
    const saved = await upsertGithubPlan(env as Bindings, s, plan);
    expect(saved.approvalSignature).toBeTruthy();
    const keyId = await s.getPlanApprovalKeyId(plan.id);
    const stored = await s.getPlan(plan.id);
    const signer = await platformSigner(env as Bindings);
    expect(await verifyPlanApproval(signer, stored!, keyId!)).toMatchObject({ ok: true });
  });

  it("a GitHub login someone linked acts as that human; anyone else as their own disabled principal", async () => {
    const s = store();
    const human = await seedPrincipal(s, { kind: "human" });
    await s.db
      .insert(githubInstallationLinks)
      .values({
        installationId: 990001,
        principalId: human,
        githubLogin: "linked-dev",
        githubUserId: 31,
        linkedAt: new Date().toISOString(),
      });
    expect(await githubActorPrincipal(s, { kind: "human", id: "31", login: "linked-dev" })).toBe(
      human,
    );
    const own = await githubActorPrincipal(s, { kind: "human", id: "32", login: "stranger" });
    expect(own).toBe("gh-u-32");
    expect(await githubActorPrincipal(s, { kind: "agent", id: "33", login: "linked-dev" })).toBe(
      "gh-u-33",
    );
  });
});
