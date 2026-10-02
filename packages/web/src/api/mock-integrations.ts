/**
 * Mock backend for external integrations: the developer portal, the delivery log, the install
 * screen and installed integrations. Synthetic data only; mutations persist for the life of the
 * tab, and installing on the install screen shows up on the Integrations page.
 *
 * Install request ids: `demo` (fresh install), `update` (already installed), `empty` (no repos you
 * own), `expired`, `decided` (already approved), anything else → 404.
 */
import { SCOPE_CATALOG } from "../lib/integrations.js";
import { ago, ahead, b64u, sha } from "./fixture-kit.js";
import { repos as fixtureRepos } from "./fixtures.js";
import type {
  DeliveryDetail,
  DeliverySummary,
  InstallationView,
  InstallView,
  IntegrationInput,
  IntegrationScope,
  IntegrationView,
  RepoRef,
  SecretView,
  WebhookEvent,
} from "./integrations.js";

export interface MockResponse {
  status: number;
  body: unknown;
}

const ok = (body: unknown, status = 200): MockResponse => ({ status, body: structuredClone(body) });
const fail = (status: number, code: string, message: string, explanation: string): MockResponse => ({
  status,
  body: { error: { code, message, fix: { explanation, docsUrl: "/docs/integrations" } } },
});

const ME = { id: "prn_maya", name: "Maya Okafor", handle: "maya" };
const ORIGIN = typeof window === "undefined" ? "https://gittifacts.dev" : window.location.origin;

/** Claimed repositories Maya owns: the only ones an integration can be installed on. */
const REPOS: RepoRef[] = fixtureRepos()
  .map((r) => r.repo)
  .filter((r) => r.claim.status === "claimed" && r.claim.ownerId === ME.id)
  .map((r) => ({ id: r.id, name: r.name, fullName: `${r.namespace}/${r.name}` }));
const repo = (id: string): RepoRef => REPOS.find((r) => r.id === id) ?? { id, name: id, fullName: id };

const NEVER = [
  "Push code or write any branch",
  "Approve, review or merge Changes",
  "Change repository settings, policy or secrets",
  "See your agents' push tokens",
  "Connect to unclaimed projects",
];

const explain = (scopes: IntegrationScope[]) =>
  SCOPE_CATALOG.filter((s) => scopes.includes(s.scope)).map((s) => ({ ...s }));

let seq = 100;
const nextId = (prefix: string) => `${prefix}_${(seq++).toString(36)}${b64u(`${prefix}${seq}`, 6)}`;
const hex64 = (seed: string) => (sha(`${seed}:a`) + sha(`${seed}:b`)).slice(0, 64);
const guid = (seed: string) => {
  const h = sha(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const secretValue = (seed: string) => `gtfs_${b64u(seed, 40)}`;
const secretView = (seed: string, createdMin: number, usedMin: number | null): SecretView => ({
  id: `sec_${b64u(seed, 8)}`,
  prefix: secretValue(seed).slice(0, 12),
  createdAt: ago(createdMin),
  lastUsedAt: usedMin === null ? null : ago(usedMin),
});

// ---------------------------------------------------------------- developer integrations

const DEPLOY: IntegrationScope[] = ["repo:read", "contents:read", "webhooks", "deployments:write"];

const integrations: IntegrationView[] = [
  {
    id: "int_cfwb",
    clientId: "gtfi_9c1e4b7a2d",
    name: "Cloudflare Workers Builds",
    description: "Builds and deploys Workers from gittifacts: production from main, a preview per Change.",
    logoUrl: null,
    homepageUrl: "https://workers.cloudflare.com",
    redirectUris: [
      "https://dash.cloudflare.com/api/gittifacts/callback",
      "http://localhost:8788/callback",
    ],
    clientType: "confidential",
    scopes: DEPLOY,
    webhook: {
      url: "https://builds.workers.example/hooks/gittifacts",
      active: true,
      events: ["push", "change.created", "change.updated", "change.merged", "installation.created", "installation.deleted"],
      secretSet: true,
    },
    secrets: [secretView("cfwb-2", 60 * 24 * 3, 2), secretView("cfwb-1", 60 * 24 * 74, 60 * 24 * 3 + 40)],
    installationCount: 3,
    createdAt: ago(60 * 24 * 74),
    updatedAt: ago(60 * 24 * 3),
  },
  {
    id: "int_netlify_stg",
    clientId: "gtfi_41f07c2be8",
    name: "Netlify (staging)",
    description: "Staging app for the Netlify connector. Not for production sites.",
    logoUrl: null,
    homepageUrl: "https://staging.netlify.example",
    redirectUris: ["https://app.staging.netlify.example/auth/gittifacts/callback"],
    clientType: "public",
    scopes: [...DEPLOY, "checks:write"],
    webhook: {
      url: "https://api.staging.netlify.example/hooks/gittifacts",
      active: false,
      events: ["push", "change.created", "change.updated"],
      secretSet: true,
    },
    secrets: [],
    installationCount: 0,
    createdAt: ago(60 * 24 * 12),
    updatedAt: ago(60 * 24 * 2),
  },
];

// ---------------------------------------------------------------- deliveries

interface DeliverySeed {
  id: string;
  integrationId: string;
  event: WebhookEvent;
  action?: string | null;
  repoId?: string | null;
  status: DeliverySummary["status"];
  attempts: number;
  responseStatus: number | null;
  durationMs: number | null;
  createdMin: number;
  lastAttemptMin?: number | null;
  nextAttemptMin?: number | null;
  redeliveryOf?: string | null;
  responseBody?: string | null;
  error?: string | null;
}

function payloadFor(s: DeliverySeed, id: string): string {
  const r = s.repoId ? repo(s.repoId) : null;
  const repository = r
    ? {
        id: r.id,
        name: r.name,
        fullName: r.fullName,
        defaultBranch: "main",
        cloneUrl: `${ORIGIN}/git/${r.fullName}.git`,
      }
    : null;
  const installation = { id: "inst_cfwb_maya", account: { kind: "human", handle: ME.handle } };
  const sender = { id: ME.id, kind: "human", name: ME.name };
  const change = (n: number) => ({
    id: `chg_${b64u(`${s.id}-chg`, 6)}`,
    number: n,
    title: "Retry webhook deliveries with jittered backoff",
    headSha: sha(`${s.id}-head`),
    lane: 1,
    url: `${ORIGIN}/changes/chg_${b64u(`${s.id}-chg`, 6)}`,
  });
  const body: Record<string, unknown> = { event: s.event, delivery: id };
  if (s.action) body.action = s.action;
  switch (s.event) {
    case "push":
      Object.assign(body, {
        ref: "refs/heads/main",
        before: sha(`${s.id}-before`),
        after: sha(`${s.id}-after`),
        headCommit: { sha: sha(`${s.id}-after`), message: "Merge Change #41: cache invoice totals", author: "fleet-coder-07" },
        change: null,
      });
      break;
    case "change.created":
    case "change.updated":
    case "change.merged":
    case "change.reverted":
      body.change = change(41);
      break;
    case "ping":
      body.zen = "Humans approve intent. Machines prove conformance.";
      body.hook = { url: integrations.find((i) => i.id === s.integrationId)?.webhook.url ?? null };
      break;
    default:
      break;
  }
  Object.assign(body, { repository, installation, sender });
  return JSON.stringify(body);
}

/** Which integration each delivery belongs to (not part of the wire shape). */
const owners = new Map<string, string>();
const deliveryOwner = (d: DeliveryDetail) => owners.get(d.id);

function makeDelivery(s: DeliverySeed): DeliveryDetail {
  owners.set(s.id, s.integrationId);
  const g = guid(s.id);
  const payload = payloadFor(s, g);
  const integration = integrations.find((i) => i.id === s.integrationId);
  return {
    id: s.id,
    guid: g,
    event: s.event,
    action: s.action ?? null,
    repo: s.repoId ? { id: s.repoId, name: repo(s.repoId).name } : null,
    installationId: s.event === "ping" ? null : "inst_cfwb_maya",
    status: s.status,
    attempts: s.attempts,
    responseStatus: s.responseStatus,
    durationMs: s.durationMs,
    createdAt: ago(s.createdMin),
    lastAttemptAt: s.lastAttemptMin === null ? null : ago(s.lastAttemptMin ?? s.createdMin),
    nextAttemptAt: s.nextAttemptMin == null ? null : ahead(s.nextAttemptMin),
    redeliveryOf: s.redeliveryOf ?? null,
    url: integration?.webhook.url ?? "https://example.invalid/hook",
    requestHeaders: {
      "Content-Type": "application/json",
      "User-Agent": "gittifacts-webhooks/1.0",
      "X-Gittifacts-Event": s.event,
      "X-Gittifacts-Delivery": g,
      "X-Gittifacts-Signature-256": `sha256=${hex64(payload)}`,
      ...(s.event === "ping" ? {} : { "X-Gittifacts-Installation": "inst_cfwb_maya" }),
    },
    payload,
    responseBody: s.responseBody === undefined ? (s.responseStatus === 200 ? '{"ok":true}' : null) : s.responseBody,
    error: s.error ?? null,
  };
}

const BAD_GATEWAY =
  "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";

const deliveries: DeliveryDetail[] = [
  { id: "dlv_07", integrationId: "int_cfwb", event: "push", repoId: "repo_billing", status: "delivered", attempts: 1, responseStatus: 200, durationMs: 142, createdMin: 3 },
  { id: "dlv_06", integrationId: "int_cfwb", event: "change.updated", action: "synchronize", repoId: "repo_dashboard", status: "pending", attempts: 2, responseStatus: 503, durationMs: 10_000, createdMin: 9, lastAttemptMin: 2, nextAttemptMin: 4, responseBody: "upstream timed out", error: "Timed out after 10 s waiting for a response (attempt 2 of 8)." },
  { id: "dlv_05", integrationId: "int_cfwb", event: "change.created", repoId: "repo_dashboard", status: "delivered", attempts: 1, responseStatus: 202, durationMs: 214, createdMin: 18, responseBody: '{"queued":true,"build":"bld_7Hc2"}' },
  { id: "dlv_04", integrationId: "int_cfwb", event: "push", repoId: "repo_edge", status: "delivered", attempts: 1, responseStatus: 200, durationMs: 388, createdMin: 41, redeliveryOf: "dlv_03" },
  { id: "dlv_03", integrationId: "int_cfwb", event: "push", repoId: "repo_edge", status: "failed", attempts: 8, responseStatus: 502, durationMs: 1_204, createdMin: 60 * 7, lastAttemptMin: 52, responseBody: BAD_GATEWAY, error: "Gave up after 8 attempts over 6 h. The last answer was 502 Bad Gateway." },
  { id: "dlv_02", integrationId: "int_cfwb", event: "change.merged", repoId: "repo_billing", status: "cancelled", attempts: 0, responseStatus: null, durationMs: null, createdMin: 60 * 26, lastAttemptMin: null, error: "Cancelled: the webhook was paused before the first attempt." },
  { id: "dlv_01", integrationId: "int_cfwb", event: "installation.created", repoId: null, status: "delivered", attempts: 1, responseStatus: 204, durationMs: 96, createdMin: 60 * 24 * 3, responseBody: "" },
  { id: "dlv_00", integrationId: "int_cfwb", event: "ping", repoId: null, status: "delivered", attempts: 1, responseStatus: 200, durationMs: 121, createdMin: 60 * 24 * 9 },
  { id: "dlv_n1", integrationId: "int_netlify_stg", event: "ping", repoId: null, status: "failed", attempts: 3, responseStatus: null, durationMs: 10_000, createdMin: 60 * 24 * 2, lastAttemptMin: 60 * 24 * 2 - 30, error: "Couldn't connect to api.staging.netlify.example: the connection timed out." },
].map((s) => makeDelivery(s as DeliverySeed));

function summary(d: DeliveryDetail): DeliverySummary {
  const { url: _u, requestHeaders: _h, payload: _p, responseBody: _r, error: _e, ...rest } = d;
  return rest;
}

// ---------------------------------------------------------------- installations (Maya's)

const installations: InstallationView[] = [
  {
    id: "inst_cfwb_maya",
    integration: {
      id: "int_cfwb",
      name: "Cloudflare Workers Builds",
      logoUrl: null,
      homepageUrl: "https://workers.cloudflare.com",
      developer: { name: "Cloudflare" },
    },
    account: { id: ME.id, kind: "human", handle: ME.handle },
    scopes: explain(DEPLOY),
    repoSelection: "selected",
    repos: [repo("repo_billing"), repo("repo_edge")],
    status: "active",
    createdAt: ago(60 * 24 * 3),
    updatedAt: ago(60 * 24 * 3),
    lastUsedAt: ago(3),
    installedBy: { id: ME.id, name: ME.name },
  },
  {
    id: "inst_render_maya",
    integration: {
      id: "int_render",
      name: "Render",
      logoUrl: null,
      homepageUrl: "https://render.example",
      developer: { name: "Render Services" },
    },
    account: { id: ME.id, kind: "human", handle: ME.handle },
    scopes: explain(["repo:read", "contents:read", "webhooks", "deployments:write", "checks:write"]),
    repoSelection: "all",
    repos: [...REPOS],
    status: "active",
    createdAt: ago(60 * 24 * 21),
    updatedAt: ago(60 * 24 * 8),
    lastUsedAt: ago(60 * 26),
    installedBy: { id: ME.id, name: ME.name },
  },
];

// ---------------------------------------------------------------- install requests

const VERCEL = {
  id: "int_vercel",
  clientId: "gtfi_v3rc31a9f0",
  name: "Vercel",
  description: "Deploys every push to main to production and builds a preview for each Change.",
  logoUrl: null,
  homepageUrl: "https://vercel.example",
  homepageHost: "vercel.example",
  developer: { name: "Vercel Inc." },
  clientType: "confidential" as const,
};
const CFWB = {
  id: "int_cfwb",
  clientId: "gtfi_9c1e4b7a2d",
  name: "Cloudflare Workers Builds",
  description: integrations[0]?.description ?? null,
  logoUrl: null,
  homepageUrl: "https://workers.cloudflare.com",
  homepageHost: "workers.cloudflare.com",
  developer: { name: "Cloudflare" },
  clientType: "confidential" as const,
};

const decided = new Map<string, "approved" | "denied">();

function installFor(id: string): InstallView | null {
  if (!["demo", "update", "empty", "expired", "decided"].includes(id)) return null;
  const update = id === "update";
  const existing = update ? installations.find((i) => i.id === "inst_cfwb_maya" && i.status === "active") : undefined;
  const status = decided.get(id) ?? (id === "expired" ? "expired" : id === "decided" ? "approved" : "pending");
  return {
    id,
    status,
    integration: update ? CFWB : VERCEL,
    redirectHost: update ? "dash.cloudflare.com" : "vercel.example",
    scopes: explain(update ? DEPLOY : [...DEPLOY, "checks:write"]),
    never: [...NEVER],
    repos: id === "empty" ? [] : REPOS.map((r) => ({ ...r })),
    existing: existing
      ? { installationId: existing.id, repoSelection: existing.repoSelection, repoIds: existing.repos.map((r) => r.id) }
      : null,
    expiresAt: ahead(9),
  };
}

function applyInstall(view: InstallView, repoSelection: "all" | "selected", repoIds: string[]): void {
  const repos = repoSelection === "all" ? REPOS.map((r) => ({ ...r })) : repoIds.map(repo);
  const now = new Date().toISOString();
  const current = installations.find((i) => i.integration.id === view.integration.id && i.status === "active");
  if (current) {
    Object.assign(current, { repoSelection, repos, updatedAt: now });
    return;
  }
  installations.unshift({
    id: nextId("inst"),
    integration: {
      id: view.integration.id,
      name: view.integration.name,
      logoUrl: view.integration.logoUrl,
      homepageUrl: view.integration.homepageUrl,
      developer: view.integration.developer,
    },
    account: { id: ME.id, kind: "human", handle: ME.handle },
    scopes: view.scopes,
    repoSelection,
    repos,
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    installedBy: { id: ME.id, name: ME.name },
  });
}

/** Body of approve / PATCH installation: an explicit choice, repos you own. */
function readSelection(body: unknown): { repoSelection: "all" | "selected"; repoIds: string[] } | MockResponse {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const sel = b.repoSelection;
  const ids = Array.isArray(b.repoIds) ? b.repoIds.filter((x): x is string => typeof x === "string") : [];
  if (sel !== "all" && sel !== "selected") {
    return fail(400, "invalid-request", "repoSelection must be all or selected", "Choose All repositories or pick some.");
  }
  if (sel === "selected" && ids.length === 0) {
    return fail(400, "invalid-request", "pick at least one repository", "Tick at least one repository, or choose All repositories you own.");
  }
  const foreign = ids.filter((x) => !REPOS.some((r) => r.id === x));
  if (foreign.length > 0) {
    return fail(403, "repo-not-installable", `you can't install on ${foreign.join(", ")}`, "Only claimed repositories you own can be connected. Claim the project first.");
  }
  return { repoSelection: sel, repoIds: sel === "all" ? [] : ids };
}

// ---------------------------------------------------------------- developer mutations

function readInput(body: unknown, partial: boolean): Partial<IntegrationInput> | MockResponse {
  const b = (typeof body === "object" && body !== null ? body : {}) as Partial<IntegrationInput>;
  if (!partial || b.name !== undefined) {
    if (typeof b.name !== "string" || b.name.trim().length < 2) {
      return fail(400, "invalid-request", "name is required", "Give the integration a name people will recognise, 2 to 60 characters.");
    }
  }
  if (!partial || b.redirectUris !== undefined) {
    if (!Array.isArray(b.redirectUris) || b.redirectUris.length === 0) {
      return fail(400, "invalid-request", "at least one redirect URI is required", "Add the exact callback URL your OAuth flow returns to.");
    }
  }
  if (!partial || b.scopes !== undefined) {
    if (!Array.isArray(b.scopes) || b.scopes.length === 0) {
      return fail(400, "invalid-request", "pick at least one permission", "Deploy platforms usually need the first four.");
    }
  }
  if (b.webhook?.url && !b.scopes?.includes("webhooks") && !partial) {
    return fail(400, "invalid-request", "a webhook needs the webhooks permission", "Tick Receive events, or leave the webhook URL empty.");
  }
  return b;
}

function create(body: unknown): MockResponse {
  const input = readInput(body, false);
  if ("status" in input) return input as MockResponse;
  const i = input as IntegrationInput;
  const id = nextId("int");
  const confidential = (i.clientType ?? "confidential") === "confidential";
  const secret = confidential ? secretValue(`${id}-secret`) : null;
  const hookUrl = i.webhook?.url ?? null;
  const webhookSecret = hookUrl && !i.webhook?.secret ? `whsec_${b64u(`${id}-whsec`, 32)}` : null;
  const now = new Date().toISOString();
  const integration: IntegrationView = {
    id,
    clientId: `gtfi_${sha(id).slice(0, 10)}`,
    name: i.name.trim(),
    description: i.description ?? null,
    logoUrl: i.logoUrl ?? null,
    homepageUrl: i.homepageUrl,
    redirectUris: i.redirectUris,
    clientType: confidential ? "confidential" : "public",
    scopes: i.scopes,
    webhook: { url: hookUrl, active: i.webhook?.active ?? true, events: i.webhook?.events ?? [], secretSet: Boolean(hookUrl) },
    secrets: secret ? [{ id: `sec_${b64u(id, 8)}`, prefix: secret.slice(0, 12), createdAt: now, lastUsedAt: null }] : [],
    installationCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  integrations.unshift(integration);
  return ok({ integration, clientSecret: secret, webhookSecret }, 201);
}

function patch(it: IntegrationView, body: unknown): MockResponse {
  const input = readInput(body, true);
  if ("status" in input) return input as MockResponse;
  const p = input as Partial<IntegrationInput>;
  if (p.name !== undefined) it.name = p.name.trim();
  if (p.description !== undefined) it.description = p.description;
  if (p.logoUrl !== undefined) it.logoUrl = p.logoUrl;
  if (p.homepageUrl !== undefined) it.homepageUrl = p.homepageUrl;
  if (p.redirectUris !== undefined) it.redirectUris = p.redirectUris;
  if (p.scopes !== undefined) it.scopes = p.scopes;
  if (p.webhook !== undefined) {
    it.webhook = {
      url: p.webhook.url,
      events: p.webhook.events,
      active: p.webhook.active ?? it.webhook.active,
      secretSet: it.webhook.secretSet || Boolean(p.webhook.secret),
    };
  }
  it.updatedAt = new Date().toISOString();
  return ok({ integration: it });
}

function queueDelivery(it: IntegrationView, event: WebhookEvent, redeliveryOf: DeliveryDetail | null): DeliveryDetail {
  const d = makeDelivery({
    id: nextId("dlv"),
    integrationId: it.id,
    event,
    action: redeliveryOf?.action ?? null,
    repoId: redeliveryOf?.repo?.id ?? null,
    status: "pending",
    attempts: 0,
    responseStatus: null,
    durationMs: null,
    createdMin: 0,
    lastAttemptMin: null,
    redeliveryOf: redeliveryOf?.id ?? null,
  });
  if (redeliveryOf) d.payload = redeliveryOf.payload;
  deliveries.unshift(d);
  // The mock receiver answers a moment later: pings and redeliveries succeed while the hook is active.
  setTimeout(() => {
    Object.assign(d, it.webhook.active
      ? { status: "delivered", attempts: 1, responseStatus: 200, durationMs: 163, lastAttemptAt: new Date().toISOString(), responseBody: '{"ok":true}' }
      : { status: "cancelled", error: "Cancelled: the webhook is paused." });
  }, 1500);
  return d;
}

// ---------------------------------------------------------------- router

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const notFound = (what: string) => fail(404, "not-found", `no such ${what}`, "Reload the list; it may have been deleted.");

export async function handle(method: string, path: string, body?: unknown): Promise<MockResponse> {
  await wait(method === "GET" ? 160 : 520);
  const url = new URL(path, ORIGIN);
  const p = url.pathname;

  // install screen
  let m = /^\/api\/v1\/integration-installs\/([^/]+)(?:\/(approve|deny))?$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[1] ?? "");
    const view = installFor(id);
    if (!view) {
      return fail(404, "install-request-not-found", "this installation request doesn't exist", "Start the connection again from the integration's site. Requests last 10 minutes.");
    }
    if (method === "GET" && !m[2]) return ok({ install: view });
    if (method !== "POST") return notFound("route");
    if (view.status !== "pending") {
      return fail(409, "install-request-decided", `this request was already ${view.status}`, `Go back to ${view.integration.name} and connect again for a new request.`);
    }
    const back = `https://${view.redirectHost}/api/gittifacts/callback`;
    if (m[2] === "deny") {
      decided.set(id, "denied");
      return ok({ redirectTo: `${back}?error=access_denied&state=mock` });
    }
    const sel = readSelection(body);
    if ("status" in sel) return sel;
    decided.set(id, "approved");
    applyInstall(view, sel.repoSelection, sel.repoIds);
    return ok({ redirectTo: `${back}?code=mock-code&state=mock&installation_id=${view.existing?.installationId ?? "new"}` });
  }

  // installed integrations
  if (p === "/api/v1/installations" && method === "GET") {
    return ok({ installations: installations.filter((i) => i.status === "active") });
  }
  m = /^\/api\/v1\/installations\/([^/]+)(\/uninstall)?$/.exec(p);
  if (m) {
    const inst = installations.find((i) => i.id === decodeURIComponent(m?.[1] ?? "") && i.status === "active");
    if (!inst) return notFound("installation");
    if (method === "POST" && m[2]) {
      inst.status = "deleted";
      inst.updatedAt = new Date().toISOString();
      return ok({ installation: inst });
    }
    if (method === "PATCH" && !m[2]) {
      const sel = readSelection(body);
      if ("status" in sel) return sel;
      inst.repoSelection = sel.repoSelection;
      inst.repos = sel.repoSelection === "all" ? REPOS.map((r) => ({ ...r })) : sel.repoIds.map(repo);
      inst.updatedAt = new Date().toISOString();
      return ok({ installation: inst });
    }
  }

  // developer portal
  if (p === "/api/v1/integrations") {
    if (method === "GET") return ok({ integrations });
    if (method === "POST") return create(body);
  }
  m = /^\/api\/v1\/integrations\/([^/]+)(?:\/(.*))?$/.exec(p);
  if (m) {
    const it = integrations.find((i) => i.id === decodeURIComponent(m?.[1] ?? ""));
    if (!it) return notFound("integration");
    const rest = m[2] ?? "";
    if (!rest) {
      if (method === "GET") return ok({ integration: it });
      if (method === "PATCH") return patch(it, body);
      if (method === "DELETE") {
        integrations.splice(integrations.indexOf(it), 1);
        let uninstalled = 0;
        for (const inst of installations) {
          if (inst.integration.id === it.id && inst.status === "active") {
            inst.status = "deleted";
            uninstalled++;
          }
        }
        return ok({ deleted: true, uninstalled: Math.max(uninstalled, it.installationCount) });
      }
    }
    if (rest === "secrets" && method === "POST") {
      if (it.clientType === "public") {
        return fail(409, "public-client", "public clients have no secret", "Public clients prove themselves with PKCE. Switch to confidential to use a secret.");
      }
      const id = nextId("sec");
      const clientSecret = secretValue(id);
      const secret: SecretView = { id, prefix: clientSecret.slice(0, 12), createdAt: new Date().toISOString(), lastUsedAt: null };
      it.secrets.unshift(secret);
      return ok({ clientSecret, secret, integration: it }, 201);
    }
    const sm = /^secrets\/([^/]+)$/.exec(rest);
    if (sm && method === "DELETE") {
      const idx = it.secrets.findIndex((s) => s.id === decodeURIComponent(sm[1] ?? ""));
      if (idx < 0) return notFound("secret");
      if (it.secrets.length === 1) {
        return fail(409, "last-secret", "can't revoke the only secret", "Generate a new secret first, deploy it, then revoke this one.");
      }
      it.secrets.splice(idx, 1);
      return ok({ integration: it });
    }
    if (rest === "webhook-secret" && method === "POST") {
      it.webhook.secretSet = true;
      return ok({ webhookSecret: `whsec_${b64u(nextId("wh"), 32)}`, integration: it });
    }
    if (rest === "ping" && method === "POST") {
      if (!it.webhook.url) return fail(409, "no-webhook", "no webhook URL is set", "Add a webhook URL first, then send a ping.");
      return ok({ delivery: summary(queueDelivery(it, "ping", null)) }, 202);
    }
    if (rest === "deliveries" && method === "GET") {
      const status = url.searchParams.get("status");
      const event = url.searchParams.get("event");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const list = deliveries
        .filter((d) => deliveryOwner(d) === it.id)
        .filter((d) => (!status || d.status === status) && (!event || d.event === event))
        .slice(0, limit)
        .map(summary);
      return ok({ deliveries: list });
    }
    const dm = /^deliveries\/([^/]+)(\/redeliver)?$/.exec(rest);
    if (dm) {
      const d = deliveries.find((x) => x.id === decodeURIComponent(dm[1] ?? "") && deliveryOwner(x) === it.id);
      if (!d) return notFound("delivery");
      if (method === "GET" && !dm[2]) return ok({ delivery: d });
      if (method === "POST" && dm[2]) return ok({ delivery: summary(queueDelivery(it, d.event, d)) }, 202);
    }
  }
  return fail(404, "not-found", `No mock route for ${method} ${p}.`, "Reload the page.");
}
