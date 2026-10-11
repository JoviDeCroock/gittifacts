/**
 * M10 (security audit 2026-10-11): a lone UTF-16 surrogate in free text must never commit a state
 * change without its audit entry. Canonical JSON (the audit chain's hash input) rejects lone
 * surrogates, so the API refuses them at the boundary, and the audit log never fails on them.
 */
import { env } from "cloudflare:workers";
import type { Plan } from "@app/domain";
import { describe, expect, it } from "vitest";
import { auditLogStub, DoAudit } from "../src/audit/audit.js";
import { addMember, repoFixture, store } from "./fixtures.js";
import { call, createAgent, expectError, json, makeApp, ORIGIN, signUpHuman } from "./http.js";

const LONE = "\ud800";

async function setup() {
  const { app } = makeApp();
  const repo = repoFixture();
  await store().insertRepo(repo);
  const alice = await signUpHuman(app, "Alice");
  const bob = await signUpHuman(app, "Bob");
  const agent = await createAgent(app, alice.cookie);
  await addMember(store(), repo.id, alice.principal.id, "owner");
  await addMember(store(), repo.id, bob.principal.id, "maintainer");
  return { app, repo, alice, bob, agent };
}

const draft = (repoId: string, extra: Record<string, unknown> = {}) => ({
  repoId,
  title: "Rate limit logins",
  intent: "Stop credential stuffing by limiting login attempts per IP.",
  acceptanceCriteria: ["The 6th attempt within a minute returns 429"],
  ...extra,
});

async function planActions(app: ReturnType<typeof makeApp>["app"], cookie: string, id: string) {
  const audit = await json<{ events: { action: string }[] }>(
    await call(app, "GET", `/api/v1/audit?subject=plan:${id}`, { cookie }),
  );
  return audit.events.map((e) => e.action);
}

describe("lone surrogates in request text", () => {
  it("approving a plan with a lone-surrogate comment is refused and leaves the plan a draft", async () => {
    const { app, repo, bob, agent } = await setup();
    const { plan } = await json<{ plan: Plan }>(
      await call(app, "POST", "/api/v1/plans", { token: agent.token, body: draft(repo.id) }),
    );
    // JSON.stringify writes the lone surrogate as the escape "\ud800", as an attacker would.
    const res = await call(app, "POST", `/api/v1/plans/${plan.id}/approve`, {
      cookie: bob.cookie,
      body: { comment: `lgtm ${LONE}` },
    });
    await expectError(res, 400, "invalid-request");
    expect((await store().getPlan(plan.id))?.status).toBe("draft");
    expect(await planActions(app, bob.cookie, plan.id)).toEqual(["plan.created"]);

    // The same approval with well-formed text (an escaped surrogate pair) works and is audited.
    const ok = await call(app, "POST", `/api/v1/plans/${plan.id}/approve`, {
      cookie: bob.cookie,
      body: { comment: "lgtm 🚀" },
    });
    expect(ok.status).toBe(200);
    expect(await planActions(app, bob.cookie, plan.id)).toEqual(["plan.approved", "plan.created"]);
  });

  it("refuses lone surrogates in any JSON body field and in object keys, before auth", async () => {
    const { app, repo, agent } = await setup();
    await expectError(
      await call(app, "POST", "/api/v1/plans", {
        token: agent.token,
        body: draft(repo.id, { acceptanceCriteria: [`ok`, `x${"\udc00"}y`] }),
      }),
      400,
      "invalid-request",
    );
    await expectError(
      await call(app, "POST", "/api/v1/plans", {
        token: agent.token,
        body: { ...draft(repo.id), [`k${LONE}`]: 1 },
      }),
      400,
      "invalid-request",
    );
    // A literal backslash before "ud800" is ordinary text, not an escape.
    const literal = await call(app, "POST", "/api/v1/plans", {
      token: agent.token,
      body: draft(repo.id, { title: "a \\ud800 b" }),
    });
    expect(literal.status).toBe(201);
  });

  it("refuses lone surrogates in MCP tool arguments", async () => {
    const { app, repo, agent } = await setup();
    const res = await call(app, "POST", "/mcp", {
      token: agent.token,
      headers: { accept: "application/json, text/event-stream", origin: ORIGIN },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_plan", arguments: draft(repo.id, { title: `t${LONE}` }) },
      },
    });
    expect(res.status).toBe(400);
  });

  it("the audit log records a payload with a lone surrogate instead of failing the append", async () => {
    const log = `surrogate-${crypto.randomUUID()}`;
    const ev = await new DoAudit(env, log).append({
      principalId: "system",
      action: "change.pushed",
      subject: "change:c1",
      payload: { title: `${"a".repeat(3)}${LONE}` },
    });
    expect(ev.seq).toBe(1);
    expect((await auditLogStub(env, log).verifyChain()).verified).toBe(true);
  });
});
