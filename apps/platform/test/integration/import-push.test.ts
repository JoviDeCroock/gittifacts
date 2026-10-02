/**
 * Import by push (src/import/push-grant.ts): a human owner creates an empty project, pushes the
 * history with a one-time main-repo grant, and the first push closes it (token revoked); then
 * the bootstrap CI and the O5 detection proposal start. Agents and anonymous callers never get
 * a grant, and none is issued once the default branch exists.
 *
 * Real: the Worker, D1, the PushRouter workflow and the coordinator facade. Fake: Artifacts
 * (FakeGitHost; a "push" is a commit on the main repo plus the event Artifacts would send).
 */
import { createPlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it } from "vitest";
import { call, createAgent, expectError, json, ORIGIN, signUpHuman } from "../http.js";
import { type IntegrationFakes, resetIntegrationFakes } from "./fakes.js";
import { fetchVia, platformApp } from "./harness.js";
import {
  auditActions,
  createPushProject,
  deliverPush,
  eventually,
  grantStatus,
} from "./import-push-helpers.js";
import { resetFakeWorkspaces } from "./workspace-fakes.js";

let fakes: IntegrationFakes;
beforeEach(() => {
  fakes = resetIntegrationFakes();
  resetFakeWorkspaces();
});

const FILES = {
  "package.json": JSON.stringify({ name: "private-app", scripts: { test: "vitest run" } }),
  "src/index.ts": "export const x = 1;\n",
};

describe("import by push", () => {
  it("gives a human owner a one-time main-repo grant that the first push closes", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const p = await createPushProject(app, human.cookie);
    const repo = fakes.git.repo(p.name);
    // Empty: no commit, no bootstrap Change, no first Change (either would close the grant).
    expect(repo.refs.size).toBe(0);
    expect(p).toMatchObject({ remote: null, bootstrapChangeId: null, token: null });
    expect(p.importGrant).toMatchObject({ url: fakes.git.remoteOf(p.name), branch: "main" });
    expect(p.importGrant.command).toContain('http.extraHeader="Authorization: Bearer $');
    expect(p.importGrant.command).not.toContain(p.importGrant.token);
    const minted = fakes.git.tokens.filter((t) => t.repo === p.name && t.id !== undefined);
    expect(minted).toEqual([expect.objectContaining({ ttlSeconds: 1800, revoked: false })]);
    expect(await grantStatus(app, human.cookie, p.projectId)).toMatchObject({
      status: "open",
      imported: false,
      openedBy: human.principal.id,
    });
    // The token itself is never readable again.
    const status = await call(app, "GET", `/api/v1/repos/${p.projectId}/import-grant`, {
      cookie: human.cookie,
    });
    expect(await status.text()).not.toContain(p.importGrant.token);

    // The human pushes main (one push), Artifacts announces it, the observer closes the grant.
    const head = fakes.git.commit(p.name, "main", FILES, "history");
    await deliverPush(p.name, "refs/heads/main", head);
    const closed = await eventually(
      () => grantStatus(app, human.cookie, p.projectId),
      (g) => g?.status === "closed",
    );
    expect(closed).toMatchObject({ closeReason: "pushed", mainSha: head, imported: true });
    expect(minted[0]?.revoked).toBe(true);

    // What follows the import: the detection proposal (Plan + Change) and the bootstrap CI.
    const proposal = await eventually(
      async () =>
        json<{ proposal: { baseSha: string } | null }>(
          await call(app, "GET", `/api/v1/repos/${p.projectId}/platform-config`, {
            cookie: human.cookie,
          }),
        ),
      (r) => r.proposal !== null,
    );
    expect(proposal.proposal).toMatchObject({ baseSha: head });
    const actions = (await auditActions(app, human.cookie, p.projectId)).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "repo.created",
        "project.import-push-opened",
        "project.import-push-closed",
        "repo.platform-config-requested",
      ]),
    );

    // Main exists now: no grant can ever be issued for it again.
    await expectError(
      await call(app, "POST", `/api/v1/repos/${p.projectId}/import-grant`, {
        cookie: human.cookie,
      }),
      409,
      "already-imported",
    );
  });

  it("is for humans only: agents (HTTP and MCP) and anonymous callers are refused", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    await expectError(
      await call(app, "POST", "/api/v1/projects", {
        token: agent.token,
        body: { name: "agent-import", importMode: "push" },
      }),
      403,
      "human-required",
    );
    await expectError(
      await call(app, "POST", "/api/v1/projects", {
        body: { name: "anon-import", importMode: "push" },
      }),
      401,
      "unauthorized",
    );
    await expectError(
      await call(app, "POST", "/api/v1/projects", {
        cookie: human.cookie,
        body: { name: "both", importMode: "push", template: "workers-api" },
      }),
      400,
      "invalid-request",
    );
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
    try {
      const r = await mcp.tools.create_project({ name: "mcp-import", importMode: "push" });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toContain("human-required");
    } finally {
      await mcp.client.close();
    }
    expect(fakes.git.tokens.filter((t) => t.id !== undefined)).toEqual([]);
    for (const name of ["agent-import", "anon-import", "mcp-import"]) {
      expect(fakes.git.repos.has(name)).toBe(false);
    }
  });
});
