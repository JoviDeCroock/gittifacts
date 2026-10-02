/**
 * Platform auditors (PLATFORM_AUDITORS): read every repo (unclaimed projects included) and the whole
 * audit log, and are refused on every mutating route and tool.
 */
import { env } from "cloudflare:workers";
import { createPlatformClient } from "@app/mcp/client";
import { describe, expect, it } from "vitest";
import { DoAudit } from "../src/audit/audit.js";
import { readPaths, world } from "./access-helpers.js";
import { repoFixture } from "./fixtures.js";
import { createAgent, ORIGIN, signUpHuman } from "./http.js";
import { fetchWith, request } from "./integration/unclaimed-helpers.js";

async function auditors() {
  const w = await world();
  const operator = await signUpHuman(w.app, "Operator");
  const checker = await createAgent(w.app, operator.cookie);
  const human = await signUpHuman(w.app, "Auditor");
  const vars = { PLATFORM_AUDITORS: `${checker.principal.id}, ${human.principal.id}` };
  const unclaimed = repoFixture({
    claim: { status: "unclaimed", ownerId: null, expiresAt: "2099-01-01T00:00:00.000Z" },
  });
  await w.s.insertRepo(unclaimed);
  await new DoAudit(env).append({
    principalId: "system",
    action: "test.platform-event",
    subject: `platform:${unclaimed.id}`,
    payload: {},
  });
  return { ...w, checker, human, vars, unclaimed };
}

describe("platform auditors", () => {
  it("read every repo, unclaimed projects included, and the whole audit log", async () => {
    const a = await auditors();
    for (const auth of [{ token: a.checker.token }, { cookie: a.human.cookie }]) {
      for (const path of [...readPaths(a), `/api/v1/repos/${a.unclaimed.id}`]) {
        if (path.endsWith("/queue") || path.endsWith("/events")) continue;
        const res = await request(a.app, "GET", path, { ...auth, env: a.vars });
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
        await res.text();
      }
      const repos = (await (
        await request(a.app, "GET", "/api/v1/repos", { ...auth, env: a.vars })
      ).json()) as { repos: { id: string }[] };
      expect(repos.repos.map((r) => r.id)).toEqual(
        expect.arrayContaining([a.repo.id, a.unclaimed.id]),
      );
      const audit = (await (
        await request(a.app, "GET", "/api/v1/audit?limit=200", { ...auth, env: a.vars })
      ).json()) as { events: { subject: string }[] };
      const subjects = audit.events.map((e) => e.subject);
      expect(subjects).toContain(`change:${a.change.id}`);
      expect(subjects).toContain(`platform:${a.unclaimed.id}`);
      const caps = (await (
        await request(a.app, "GET", "/api/v1/capabilities", { ...auth, env: a.vars })
      ).json()) as { canApprove: boolean; repos: { id: string; actions: string[] }[] };
      expect(caps.canApprove).toBe(false);
      expect(caps.repos.find((r) => r.id === a.repo.id)?.actions).toEqual(["read"]);
    }
    // Without the grant they are strangers again.
    const res = await request(a.app, "GET", `/api/v1/repos/${a.repo.id}`, {
      token: a.checker.token,
    });
    expect(res.status).toBe(404);
  });

  it("are refused on every mutating route", async () => {
    const a = await auditors();
    const r = `/api/v1/repos/${a.repo.id}`;
    const c = `/api/v1/changes/${a.change.id}`;
    const p = `/api/v1/plans/${a.plan.id}`;
    const writes: Array<[string, string, unknown]> = [
      [
        "POST",
        "/api/v1/plans",
        { repoId: a.repo.id, title: "Audit", intent: "x", acceptanceCriteria: ["y"] },
      ],
      ["POST", `${p}/approve`, {}],
      ["POST", `${p}/reject`, { comment: "no" }],
      ["POST", "/api/v1/changes", { repoId: a.repo.id, title: "Audit", category: "fix" }],
      ["POST", `${c}/token`, undefined],
      ["POST", `${c}/review`, { decision: "approve" }],
      ["POST", `${c}/request-review`, {}],
      ["POST", `${c}/kill`, { reason: "audit" }],
      ["POST", `${c}/queue`, {}],
      ["DELETE", `${c}/queue`, undefined],
      ["PATCH", `${r}/lane0`, { enabled: false }],
      ["PATCH", `${r}/deploy-target`, { script: "api" }],
      ["POST", `${r}/members`, { principalId: a.bob.principal.id, role: "owner" }],
      ["DELETE", `${r}/members/${a.alice.principal.id}`, undefined],
      ["POST", `${r}/queue/freeze`, { reason: "audit" }],
      ["POST", "/api/v1/repos", { name: `audit-${Date.now().toString(36)}` }],
    ];
    for (const auth of [{ token: a.checker.token }, { cookie: a.human.cookie }]) {
      for (const [method, path, body] of writes) {
        const res = await request(a.app, method, path, {
          ...auth,
          env: a.vars,
          ...(body === undefined ? {} : { body }),
        });
        const err = (await res.json()) as { error?: { code: string } };
        // forbidden (read-only auditor, or humans-only); an agent may hit its scope ceiling first.
        expect({ path, method, status: res.status }).toEqual({ path, method, status: 403 });
        expect(["forbidden", "insufficient-scope"]).toContain(err.error?.code);
      }
    }
    expect((await a.s.getPlan(a.plan.id))?.status).toBe("draft");
  });

  it("are refused on every mutating MCP tool, and read through MCP", async () => {
    const a = await auditors();
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, a.checker.token, {
      fetch: fetchWith(a.app, a.vars),
    });
    try {
      const read = await mcp.tools.get_change_status({ changeId: a.change.id });
      expect(read.isError).toBeFalsy();
      const calls = [
        mcp.tools.create_plan({
          repoId: a.repo.id,
          title: "Audit the repo",
          intent: "Auditors must never draft plans.",
          acceptanceCriteria: ["refused"],
        }),
        mcp.tools.start_change({ repoId: a.repo.id, title: "Audit the repo", category: "fix" }),
        mcp.tools.request_review({ changeId: a.change.id }),
        mcp.tools.refresh_push_token({ changeId: a.change.id }),
        mcp.tools.enqueue({ changeId: a.change.id }),
        mcp.tools.dequeue({ changeId: a.change.id }),
        mcp.tools.open_workspace({ changeId: a.change.id }),
        mcp.tools.propose_platform_config({ repoId: a.repo.id }),
        mcp.tools.create_project({ template: "workers-api" }),
      ];
      for (const r of await Promise.all(calls)) {
        expect(r.isError).toBe(true);
        expect(JSON.stringify(r.content)).toContain("auditor");
      }
    } finally {
      await mcp.client.close();
    }
  });
});
