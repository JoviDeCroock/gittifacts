/**
 * Mock backend for delegated agent auth (consent, device logins, agent sessions). Synthetic data
 * only; mutations persist for the life of the tab. Mirrors the platform's validation: agents can
 * never be granted approval-class scopes, and the repo choice is explicit.
 */
import type { Principal, Scope } from "@app/domain";
import { ago, ahead } from "./fixture-kit.js";
import { repos as fixtureRepos } from "./fixtures.js";
import type { AgentSession, ConsentDecision, ConsentView } from "./oauth.js";

export interface MockResponse {
  status: number;
  body: unknown;
}

const NEVER: Scope[] = ["repo:admin", "plan:approve", "change:review", "policy:admin"];
const GRANTABLE: Scope[] = ["repo:read", "plan:create", "change:create"];
const REPOS = fixtureRepos()
  .map((r) => r.repo)
  .filter((r) => r.claim.status === "claimed")
  .map((r) => ({ id: r.id, name: r.name }));
const repoName = (id: string) => REPOS.find((r) => r.id === id)?.name ?? id;

const ok = (body: unknown, status = 200): MockResponse => ({ status, body: structuredClone(body) });
const fail = (
  status: number,
  code: string,
  message: string,
  explanation: string,
): MockResponse => ({
  status,
  body: { error: { code, message, fix: { explanation } } },
});

const decided = new Map<string, "approved" | "denied">();

function consentFor(flow: ConsentView["flow"], id: string): ConsentView {
  const device = flow === "device_code";
  const status = decided.get(`${flow}:${id}`) ?? (id === "expired" ? "expired" : "pending");
  return {
    flow,
    id,
    status,
    client: device
      ? { id: "gittifacts-cli", name: "gittifacts CLI", uri: null, host: null, kind: "first-party" }
      : {
          id: "https://quill.example/oauth/client.json",
          name: "Quill Agent",
          uri: "https://quill.example",
          host: "quill.example",
          kind: "cimd",
        },
    redirectHost: device ? null : "quill.example",
    requestedScopes: ["repo:read", "change:create"],
    audience: device
      ? [
          { uri: `${window.location.origin}/mcp`, label: "MCP server" },
          { uri: `${window.location.origin}/api`, label: "HTTP API" },
        ]
      : [{ uri: `${window.location.origin}/mcp`, label: "MCP server" }],
    expiresAt: ahead(device ? 14 : 9),
    repos: REPOS,
    grantableScopes: GRANTABLE,
    neverScopes: NEVER,
    sessionDayChoices: [1, 7, 30, 90],
    defaultSessionDays: 30,
  };
}

function session(
  over: Partial<AgentSession> & Pick<AgentSession, "principalId" | "name">,
): AgentSession {
  return {
    flow: "authorization_code",
    client: null,
    scopes: ["repo:read", "change:create"],
    repoIds: null,
    repos: [],
    audience: null,
    createdAt: ago(60 * 24 * 2),
    lastUsedAt: ago(12),
    expiresAt: ahead(60 * 24 * 28),
    status: "active",
    revokedAt: null,
    activeTokens: 1,
    tokenPrefix: "gtf_q8Zr2mXa",
    ...over,
  };
}

const sessions: AgentSession[] = [
  session({
    principalId: "ag_quill_billing",
    name: "Quill Agent",
    client: {
      id: "https://quill.example/oauth/client.json",
      name: "Quill Agent",
      uri: "https://quill.example",
    },
    repoIds: ["repo_billing"],
    repos: [{ id: "repo_billing", name: repoName("repo_billing") }],
    audience: [`${window.location.origin}/mcp`],
  }),
  session({
    principalId: "ag_cli_laptop",
    name: "gittifacts CLI",
    flow: "device_code",
    client: { id: "gittifacts-cli", name: "gittifacts CLI", uri: null },
    scopes: ["repo:read", "plan:create", "change:create"],
    repoIds: ["repo_edge", "repo_dashboard"],
    repos: [
      { id: "repo_edge", name: repoName("repo_edge") },
      { id: "repo_dashboard", name: repoName("repo_dashboard") },
    ],
    audience: [`${window.location.origin}/mcp`, `${window.location.origin}/api`],
    createdAt: ago(60 * 24 * 6),
    lastUsedAt: ago(60 * 3),
    expiresAt: ahead(60 * 20),
    tokenPrefix: "gtf_Lw3ncY0p",
  }),
  session({
    principalId: "prn_coder07",
    name: "fleet-coder-07",
    flow: "manual",
    scopes: ["repo:read", "plan:create", "change:create"],
    createdAt: ago(60 * 24 * 41),
    lastUsedAt: ago(4),
    expiresAt: ahead(60 * 24 * 49),
    tokenPrefix: "gtf_7fQe1Kbz",
  }),
  session({
    principalId: "ag_quill_old",
    name: "Quill Agent",
    client: {
      id: "https://quill.example/oauth/client.json",
      name: "Quill Agent",
      uri: "https://quill.example",
    },
    repoIds: ["repo_ios"],
    repos: [{ id: "repo_ios", name: repoName("repo_ios") }],
    createdAt: ago(60 * 24 * 10),
    lastUsedAt: ago(60 * 24 * 3),
    expiresAt: ago(60 * 24 * 3),
    status: "expired",
    activeTokens: 0,
  }),
  session({
    principalId: "prn_triage",
    name: "issue-triager",
    flow: "manual",
    scopes: ["repo:read"],
    createdAt: ago(60 * 24 * 60),
    lastUsedAt: ago(60 * 24 * 9),
    expiresAt: null,
    status: "revoked",
    revokedAt: ago(60 * 24 * 8),
    activeTokens: 0,
  }),
];

/** Agents created on the Agents screen (main mock backend) appear as manual sessions. */
async function includeManualAgents(): Promise<void> {
  const mock = await import("./mock.js");
  const res = await mock.handle("GET", "/api/v1/principals");
  const list = (res.body as { principals?: Principal[] } | null)?.principals ?? [];
  for (const p of list) {
    if (p.kind !== "agent" || sessions.some((s) => s.principalId === p.id)) continue;
    const created = p.keys[0]?.createdAt ?? new Date().toISOString();
    sessions.unshift(
      session({
        principalId: p.id,
        name: p.name,
        flow: "manual",
        scopes: p.scopes,
        createdAt: created,
        lastUsedAt: null,
        expiresAt: ahead(60 * 24 * 90),
        tokenPrefix: "gtf_new",
      }),
    );
  }
}

function validDecision(body: unknown): MockResponse | null {
  const d = (typeof body === "object" && body !== null ? body : {}) as Partial<ConsentDecision>;
  const scopes = Array.isArray(d.scopes) ? d.scopes : [];
  const banned = scopes.filter((s) => NEVER.includes(s));
  if (banned.length > 0) {
    return fail(
      403,
      "scope-not-allowed",
      `agents can never hold ${banned.join(", ")}`,
      "Pick a subset of read, draft Plans and open Changes.",
    );
  }
  if (scopes.length === 0)
    return fail(
      400,
      "invalid-request",
      "pick at least one scope",
      "Tick at least one thing the agent may do.",
    );
  if (d.repoIds !== null && (!Array.isArray(d.repoIds) || d.repoIds.length === 0)) {
    return fail(
      400,
      "invalid-request",
      "pick at least one repository",
      "Choose the repositories, or All repositories.",
    );
  }
  return null;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function handle(method: string, path: string, body?: unknown): Promise<MockResponse> {
  await wait(method === "GET" ? 140 : 480);
  const url = new URL(path, window.location.origin);
  let m = /^\/api\/v1\/oauth\/(requests|device)\/([^/]+)(?:\/(approve|deny))?$/.exec(url.pathname);
  if (m) {
    const flow = m[1] === "device" ? "device_code" : "authorization_code";
    const id = decodeURIComponent(m[2] ?? "");
    const action = m[3];
    if (flow === "device_code" && id.replace(/[^a-z0-9]/gi, "").toUpperCase() === "ZZZZZZZZ") {
      return fail(
        404,
        "not-found",
        "no such device code",
        "Check the code on your terminal. Codes last 15 minutes; run the login again for a new one.",
      );
    }
    if (method === "GET" && !action) return ok({ consent: consentFor(flow, id) });
    if (method === "POST" && action) {
      const view = consentFor(flow, id);
      if (view.status !== "pending") {
        return fail(
          409,
          "invalid-state",
          `this request was already ${view.status}`,
          "Start the connection again from your agent.",
        );
      }
      if (action === "approve") {
        const bad = validDecision(body);
        if (bad) return bad;
      }
      decided.set(`${flow}:${id}`, action === "approve" ? "approved" : "denied");
      if (flow === "device_code")
        return ok({ status: action === "approve" ? "approved" : "denied" });
      return ok({
        redirectTo:
          action === "approve"
            ? "https://quill.example/callback?code=mock-code&state=mock&iss=demo"
            : "https://quill.example/callback?error=access_denied&state=mock",
      });
    }
  }
  if (method === "GET" && url.pathname === "/api/v1/agent-sessions") {
    await includeManualAgents();
    sessions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return ok({ sessions });
  }
  m = /^\/api\/v1\/agent-sessions\/([^/]+)\/revoke$/.exec(url.pathname);
  if (m && method === "POST") {
    const s = sessions.find((x) => x.principalId === decodeURIComponent(m?.[1] ?? ""));
    if (!s) return fail(404, "not-found", "no such agent session", "Reload the list.");
    s.status = "revoked";
    s.revokedAt = s.revokedAt ?? new Date().toISOString();
    s.activeTokens = 0;
    return ok({ session: s });
  }
  return fail(404, "not-found", `No mock route for ${method} ${url.pathname}.`, "Reload the page.");
}
