/**
 * Import by push, the other ways a grant closes (src/import/push-grant.ts): the first Change
 * (before it forks main), the TTL (cron sweep), the owner; and failing closed when Artifacts
 * can't confirm a revocation. Plus who may (re-)open one.
 */
import { env } from "cloudflare:workers";
import { bootstrapChangeIdFor } from "@app/coordinator";
import { beforeEach, describe, expect, it } from "vitest";
import { runImportGrantSweep } from "../../src/import/push-grant-runtime.js";
import { call, createAgent, expectError, json, signUpHuman } from "../http.js";
import { type IntegrationFakes, resetIntegrationFakes } from "./fakes.js";
import { platformApp } from "./harness.js";
import { auditActions, createPushProject, grantStatus } from "./import-push-helpers.js";
import { resetFakeWorkspaces } from "./workspace-fakes.js";

let fakes: IntegrationFakes;
beforeEach(() => {
  fakes = resetIntegrationFakes();
  resetFakeWorkspaces();
});

const importTokens = (repo: string) =>
  fakes.git.tokens.filter((t) => t.repo === repo && t.id !== undefined);

describe("import by push: closing", () => {
  it("closes (revokes) before the first Change, failing closed while revocation is unconfirmed", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    const p = await createPushProject(app, human.cookie);
    // The push landed but its event is late; the owner's agent starts a Change meanwhile.
    const head = fakes.git.commit(p.name, "main", { "a.txt": "a" }, "history");
    fakes.git.revokeFails = true;
    const body = { repoId: p.projectId, title: "Fix it", category: "fix" };
    await expectError(
      await call(app, "POST", "/api/v1/changes", { token: agent.token, body }),
      503,
      "import-grant-closing",
    );
    expect(await grantStatus(app, human.cookie, p.projectId)).toMatchObject({
      status: "closing",
      closeReason: "change-started",
    });
    // No fork was made while the main repo was still writable by the grant.
    expect([...fakes.git.repos.keys()].filter((n) => n.startsWith("task-"))).toEqual([]);

    fakes.git.revokeFails = false;
    const started = await call(app, "POST", "/api/v1/changes", { token: agent.token, body });
    expect(started.status).toBe(201);
    expect(importTokens(p.name).every((t) => t.revoked)).toBe(true);
    expect(await grantStatus(app, human.cookie, p.projectId)).toMatchObject({
      status: "closed",
      closeReason: "change-started",
      mainSha: head,
      imported: true,
    });
    // The import was detected through the Change path too: the bootstrap CI started.
    const boot = await call(app, "GET", `/api/v1/changes/${bootstrapChangeIdFor(p.projectId)}`, {
      cookie: human.cookie,
    });
    expect(boot.status).toBe(200);
  });

  it("expires by TTL in the cron sweep, and the owner can close or re-open it", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const p = await createPushProject(app, human.cookie);
    // Re-open while live: the old token is revoked first, a new one minted.
    const reopened = await call(app, "POST", `/api/v1/repos/${p.projectId}/import-grant`, {
      cookie: human.cookie,
    });
    expect(reopened.status).toBe(201);
    const { grant } = await json<{ grant: { token: string } }>(reopened);
    expect(grant.token).not.toBe(p.importGrant.token);
    expect(importTokens(p.name).map((t) => t.revoked)).toEqual([true, false]);

    // Past its TTL, the sweep closes it: nothing was pushed, so nothing was imported.
    await env.DB.prepare("UPDATE import_grants SET open_until = ? WHERE repo_id = ?")
      .bind("2000-01-01T00:00:00.000Z", p.projectId)
      .run();
    expect(await runImportGrantSweep(env)).toBe(1);
    expect(await grantStatus(app, human.cookie, p.projectId)).toMatchObject({
      status: "closed",
      closeReason: "expired",
      mainSha: null,
      imported: false,
    });
    expect(importTokens(p.name).every((t) => t.revoked)).toBe(true);

    // Still empty: the owner may open a fresh one, and close it at once.
    expect(
      (
        await call(app, "POST", `/api/v1/repos/${p.projectId}/import-grant`, {
          cookie: human.cookie,
        })
      ).status,
    ).toBe(201);
    const closed = await call(app, "DELETE", `/api/v1/repos/${p.projectId}/import-grant`, {
      cookie: human.cookie,
    });
    expect(await json(closed)).toMatchObject({ grant: { closeReason: "closed-by-owner" } });
    const actions = (await auditActions(app, human.cookie, p.projectId)).map((e) => e.action);
    expect(actions.filter((a) => a === "project.import-push-opened")).toHaveLength(3);
    expect(actions.filter((a) => a === "project.import-push-closed")).toHaveLength(3);
  });

  it("only the repo's human owner may open one", async () => {
    const app = platformApp();
    const owner = await signUpHuman(app);
    const agent = await createAgent(app, owner.cookie);
    const stranger = await signUpHuman(app, "Mallory");
    const p = await createPushProject(app, owner.cookie);
    const path = `/api/v1/repos/${p.projectId}/import-grant`;
    await expectError(await call(app, "POST", path, { token: agent.token }), 403, "forbidden");
    await expectError(await call(app, "POST", path, { cookie: stranger.cookie }), 404, "not-found");
    await expectError(await call(app, "DELETE", path, { token: agent.token }), 403, "forbidden");
    // A reviewer member is not enough either: admin (owner) only.
    const added = await call(app, "POST", `/api/v1/repos/${p.projectId}/members`, {
      cookie: owner.cookie,
      body: { principalId: stranger.principal.id, role: "maintainer" },
    });
    expect(added.status).toBe(201);
    await expectError(
      await call(app, "POST", path, { cookie: stranger.cookie }),
      403,
      "insufficient-role",
    );
    expect(importTokens(p.name)).toHaveLength(1);
  });
});
