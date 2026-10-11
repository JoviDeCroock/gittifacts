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
const fail = (
  status: number,
  code: string,
  message: string,
  explanation: string,
): MockResponse => ({
  status,
  body: { error: { code, message, fix: { explanation, docsUrl: "/docs/integrations" } } },
});

const ME = { id: "prn_maya", name: "Maya Okafor", handle: "maya" };
const ORIGIN = typeof window === "undefined" ? "https://gittifacts.dev" : window.location.origin;

/** Claimed repositories Maya owns or maintains: the only ones an integration can be installed on. */
const REPOS: RepoRef[] = fixtureRepos()
  .map((r) => r.repo)
  .filter((r) => r.claim.status === "claimed" && r.claim.ownerId === ME.id)
  // Some fixture names already carry their namespace ("acme/widgets"): never prefix it twice.
  .map((r) => ({
    id: r.id,
    name: r.name,
    fullName: r.name.includes("/") ? r.name : `${r.namespace}/${r.name}`,
  }));
const repo = (id: string): RepoRef =>
  REPOS.find((r) => r.id === id) ?? { id, name: id, fullName: id };

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
const secretValue = (seed: string) => `gtis_${b64u(seed, 40)}`;
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
    clientId: "gtic_9c1e4b7a2d",
    name: "Cloudflare Workers Builds",
    description:
      "Builds and deploys Workers from gittifacts: production from main, a preview per Change.",
    logoUrl: null,
    homepageUrl: "https://workers.cloudflare.com",
    redirectUris: [
      "https://dash.cloudflare.com/api/gittifacts/callback",
      "http://localhost:8788/callback",
    ],
    clientType: "confidential",
    scopes: DEPLOY,
    scopesExplained: explain(DEPLOY),
    developer: { name: "Cloudflare" },
    webhook: {
      url: "https://builds.workers.example/hooks/gittifacts",
      active: true,
      events: [
        "push",
        "change.created",
        "change.updated",
        "change.merged",
        "installation.created",
        "installation.deleted",
      ],
      secretSet: true,
    },
    secrets: [
      secretView("cfwb-2", 60 * 24 * 3, 2),
      secretView("cfwb-1", 60 * 24 * 74, 60 * 24 * 3 + 40),
    ],
    installationCount: 3,
    createdAt: ago(60 * 24 * 74),
    updatedAt: ago(60 * 24 * 3),
  },
  {
    id: "int_netlify_stg",
    clientId: "gtic_41f07c2be8",
    name: "Netlify (staging)",
    description: "Staging app for the Netlify connector. Not for production sites.",
    logoUrl: null,
    homepageUrl: "https://staging.netlify.example",
    redirectUris: ["https://app.staging.netlify.example/auth/gittifacts/callback"],
    clientType: "public",
    scopes: [...DEPLOY, "checks:write"],
    scopesExplained: explain([...DEPLOY, "checks:write"]),
    developer: { name: "Netlify" },
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

/** Maya's installation of Cloudflare Workers Builds (the deliveries below belong to it). */
const CFWB_INSTALL = "ins_c7wb2m4y";

const htmlBase = ORIGIN;
const repoPayload = (r: RepoRef) => ({
  id: r.id,
  name: r.name,
  fullName: r.fullName,
  owner: r.fullName.split("/")[0] ?? "",
  defaultBranch: "main",
  cloneUrl: `${ORIGIN}/git/${r.fullName}.git`,
  htmlUrl: `${htmlBase}/repos/${r.id}`,
  apiUrl: `${ORIGIN}/api/v1/repos/${r.id}`,
});

function changePayload(s: DeliverySeed, r: RepoRef) {
  const id = `chg_${b64u(`${s.id}-chg`, 8)}`;
  const merged = s.event === "change.merged" || s.event === "change.reverted";
  return {
    id,
    title: "Cache invoice totals per billing period",
    status:
      s.event === "change.merged"
        ? "merged"
        : s.event === "change.reverted"
          ? "reverted"
          : "awaiting-review",
    planId: `pln_${b64u(`${s.id}-plan`, 8)}`,
    baseSha: sha(`${s.id}-base`),
    headSha: sha(`${s.id}-head`),
    mergedSha: merged ? sha(`${s.id}-merged`) : null,
    lane: 1,
    revertOf: null,
    cloneUrl: `${ORIGIN}/git/${r.fullName}/changes/${id}.git`,
    htmlUrl: `${htmlBase}/changes/${id}`,
    apiUrl: `${ORIGIN}/api/v1/changes/${id}`,
  };
}

/** The envelope the server sends: event, action, deliveryId, createdAt, installation, then per-event fields. */
function payloadFor(s: DeliverySeed, deliveryId: string, createdAt: string): string {
  const r = s.repoId ? repo(s.repoId) : null;
  const body: Record<string, unknown> = {
    event: s.event,
    action: s.action ?? null,
    deliveryId,
    createdAt,
    installation: s.event === "ping" ? null : { id: CFWB_INSTALL },
  };
  switch (s.event) {
    case "push": {
      if (!r) break;
      const after = sha(`${s.id}-after`);
      Object.assign(body, {
        repository: repoPayload(r),
        kind: "default-branch",
        ref: "refs/heads/main",
        before: sha(`${s.id}-before`),
        after,
        sha: after,
        cloneUrl: `${ORIGIN}/git/${r.fullName}.git`,
        change: null,
      });
      break;
    }
    case "change.created":
    case "change.updated":
    case "change.merged":
    case "change.reverted": {
      if (!r) break;
      const change = changePayload(s, r);
      Object.assign(body, {
        repository: repoPayload(r),
        change,
        cloneUrl: change.cloneUrl,
        sha: change.mergedSha ?? change.headSha,
        ...(s.event === "change.updated" ? { changedFields: ["headSha", "status"] } : {}),
      });
      break;
    }
    case "installation.created":
    case "installation.deleted":
      body.installation = {
        id: CFWB_INSTALL,
        account: { id: ME.id, handle: ME.handle },
        repoSelection: "selected",
        repositories: ["repo_billing", "repo_edge"].map(repo).map((x) => ({
          id: x.id,
          name: x.name,
          fullName: x.fullName,
          cloneUrl: `${ORIGIN}/git/${x.fullName}.git`,
        })),
        scopes: DEPLOY,
      };
      break;
    case "ping": {
      const it = integrations.find((i) => i.id === s.integrationId);
      Object.assign(body, {
        zen: "Humans approve intent. Machines prove conformance.",
        integration: it ? { id: it.id, clientId: it.clientId, name: it.name } : null,
        hook: it
          ? { url: it.webhook.url, events: it.webhook.events, active: it.webhook.active }
          : null,
      });
      break;
    }
  }
  return JSON.stringify(body);
}

/** Which integration each delivery belongs to (not part of the wire shape). */
const owners = new Map<string, string>();
const deliveryOwner = (d: DeliveryDetail) => owners.get(d.id);

function makeDelivery(s: DeliverySeed): DeliveryDetail {
  owners.set(s.id, s.integrationId);
  const g = guid(s.id);
  const createdAt = ago(s.createdMin);
  const payload = payloadFor(s, g, createdAt);
  const integration = integrations.find((i) => i.id === s.integrationId);
  return {
    id: s.id,
    guid: g,
    event: s.event,
    action: s.action ?? null,
    repo: s.repoId ? { id: s.repoId, name: repo(s.repoId).name } : null,
    installationId: s.event === "ping" ? null : CFWB_INSTALL,
    status: s.status,
    attempts: s.attempts,
    responseStatus: s.responseStatus,
    durationMs: s.durationMs,
    createdAt,
    lastAttemptAt: s.lastAttemptMin === null ? null : ago(s.lastAttemptMin ?? s.createdMin),
    nextAttemptAt: s.nextAttemptMin == null ? null : ahead(s.nextAttemptMin),
    redeliveryOf: s.redeliveryOf ?? null,
    url: integration?.webhook.url ?? "https://example.invalid/hook",
    // Lower-case keys, as the server returns them.
    requestHeaders: {
      "content-type": "application/json",
      "user-agent": "gittifacts-Hookshot/1",
      "x-gittifacts-event": s.event,
      "x-gittifacts-delivery": g,
      "x-gittifacts-signature-256": `sha256=${hex64(payload)}`,
      ...(s.event === "ping" ? {} : { "x-gittifacts-installation-id": CFWB_INSTALL }),
    },
    payload,
    responseBody:
      s.responseBody === undefined
        ? s.responseStatus === 200
          ? '{"ok":true}'
          : null
        : s.responseBody,
    error: s.error ?? null,
  };
}

const BAD_GATEWAY =
  "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";

const deliveries: DeliveryDetail[] = [
  {
    id: "dlv_07",
    integrationId: "int_cfwb",
    event: "push",
    repoId: "repo_billing",
    status: "delivered",
    attempts: 1,
    responseStatus: 200,
    durationMs: 142,
    createdMin: 3,
  },
  {
    id: "dlv_06",
    integrationId: "int_cfwb",
    event: "change.updated",
    action: "synchronize",
    repoId: "repo_dashboard",
    status: "pending",
    attempts: 2,
    responseStatus: 503,
    durationMs: 10_000,
    createdMin: 9,
    lastAttemptMin: 2,
    nextAttemptMin: 4,
    responseBody: "upstream timed out",
    error: "Timed out after 10 s waiting for a response (attempt 2 of 8).",
  },
  {
    id: "dlv_05",
    integrationId: "int_cfwb",
    event: "change.created",
    repoId: "repo_dashboard",
    status: "delivered",
    attempts: 1,
    responseStatus: 202,
    durationMs: 214,
    createdMin: 18,
    responseBody: '{"queued":true,"build":"bld_7Hc2"}',
  },
  {
    id: "dlv_04",
    integrationId: "int_cfwb",
    event: "push",
    repoId: "repo_edge",
    status: "delivered",
    attempts: 1,
    responseStatus: 200,
    durationMs: 388,
    createdMin: 41,
    redeliveryOf: "dlv_03",
  },
  {
    id: "dlv_03",
    integrationId: "int_cfwb",
    event: "push",
    repoId: "repo_edge",
    status: "failed",
    attempts: 8,
    responseStatus: 502,
    durationMs: 1_204,
    createdMin: 60 * 7,
    lastAttemptMin: 52,
    responseBody: BAD_GATEWAY,
    error: "Gave up after 8 attempts over 6 h. The last answer was 502 Bad Gateway.",
  },
  {
    id: "dlv_02",
    integrationId: "int_cfwb",
    event: "change.merged",
    repoId: "repo_billing",
    status: "cancelled",
    attempts: 0,
    responseStatus: null,
    durationMs: null,
    createdMin: 60 * 26,
    lastAttemptMin: null,
    error: "webhook disabled",
  },
  {
    id: "dlv_01",
    integrationId: "int_cfwb",
    event: "installation.created",
    repoId: null,
    status: "delivered",
    attempts: 1,
    responseStatus: 204,
    durationMs: 96,
    createdMin: 60 * 24 * 3,
    responseBody: "",
  },
  {
    id: "dlv_00",
    integrationId: "int_cfwb",
    event: "ping",
    repoId: null,
    status: "delivered",
    attempts: 1,
    responseStatus: 200,
    durationMs: 121,
    createdMin: 60 * 24 * 9,
  },
  {
    id: "dlv_n1",
    integrationId: "int_netlify_stg",
    event: "ping",
    repoId: null,
    status: "failed",
    attempts: 3,
    responseStatus: null,
    durationMs: 10_000,
    createdMin: 60 * 24 * 2,
    lastAttemptMin: 60 * 24 * 2 - 30,
    error: "Couldn't connect to api.staging.netlify.example: the connection timed out.",
  },
].map((s) => makeDelivery(s as DeliverySeed));

function summary(d: DeliveryDetail): DeliverySummary {
  const { url: _u, requestHeaders: _h, payload: _p, responseBody: _r, error: _e, ...rest } = d;
  return rest;
}

// ---------------------------------------------------------------- installations (Maya's)

const installations: InstallationView[] = [
  {
    id: CFWB_INSTALL,
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
    eligibleRepos: REPOS.map((r) => ({ ...r })),
    status: "active",
    createdAt: ago(60 * 24 * 3),
    updatedAt: ago(60 * 24 * 3),
    lastUsedAt: ago(3),
    installedBy: { id: ME.id, name: ME.name },
  },
  {
    id: "ins_r3nd8m4y",
    integration: {
      id: "int_render",
      name: "Render",
      logoUrl: null,
      homepageUrl: "https://render.example",
      developer: { name: "Render Services" },
    },
    account: { id: ME.id, kind: "human", handle: ME.handle },
    scopes: explain([
      "repo:read",
      "contents:read",
      "webhooks",
      "deployments:write",
      "checks:write",
    ]),
    repoSelection: "all",
    repos: [...REPOS],
    eligibleRepos: REPOS.map((r) => ({ ...r })),
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
  clientId: "gtic_v3rc31a9f0",
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
  clientId: "gtic_9c1e4b7a2d",
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
  const existing = update
    ? installations.find((i) => i.id === CFWB_INSTALL && i.status === "active")
    : undefined;
  const status =
    decided.get(id) ?? (id === "expired" ? "expired" : id === "decided" ? "approved" : "pending");
  return {
    id,
    status,
    integration: update ? CFWB : VERCEL,
    redirectHost: update ? "dash.cloudflare.com" : "vercel.example",
    // The update asks for one permission more than the installation granted (checks:write).
    scopes: explain([...DEPLOY, "checks:write"]),
    never: [...NEVER],
    repos: id === "empty" ? [] : REPOS.map((r) => ({ ...r })),
    existing: existing
      ? {
          installationId: existing.id,
          repoSelection: existing.repoSelection,
          repoIds: existing.repos.map((r) => r.id),
          scopes: existing.scopes.map((x) => x.scope),
        }
      : null,
    expiresAt: ahead(9),
  };
}

function applyInstall(
  view: InstallView,
  repoSelection: "all" | "selected",
  repoIds: string[],
): void {
  const repos = repoSelection === "all" ? REPOS.map((r) => ({ ...r })) : repoIds.map(repo);
  const now = new Date().toISOString();
  const current = installations.find(
    (i) => i.integration.id === view.integration.id && i.status === "active",
  );
  if (current) {
    Object.assign(current, { repoSelection, repos, scopes: view.scopes, updatedAt: now });
    return;
  }
  installations.unshift({
    id: nextId("ins"),
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
    eligibleRepos: REPOS.map((r) => ({ ...r })),
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    installedBy: { id: ME.id, name: ME.name },
  });
}

/** Body of approve / PATCH installation: an explicit choice, repos you own or maintain. */
function readSelection(
  body: unknown,
): { repoSelection: "all" | "selected"; repoIds: string[] } | MockResponse {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const sel = b.repoSelection;
  const ids = Array.isArray(b.repoIds)
    ? b.repoIds.filter((x): x is string => typeof x === "string")
    : [];
  if (sel !== "all" && sel !== "selected") {
    return fail(
      400,
      "invalid-request",
      "repoSelection must be all or selected",
      "Choose All repositories or pick some.",
    );
  }
  if (sel === "selected" && ids.length === 0) {
    return fail(
      400,
      "invalid-request",
      "pick at least one repository",
      "Tick at least one repository, or choose All repositories you own or maintain.",
    );
  }
  const foreign = ids.filter((x) => !REPOS.some((r) => r.id === x));
  if (foreign.length > 0) {
    return fail(
      403,
      "repo-not-installable",
      `you can't install on ${foreign.join(", ")}`,
      "Only claimed repositories you own or maintain can be connected. Claim the project first, or ask its owner to make you a maintainer.",
    );
  }
  return { repoSelection: sel, repoIds: sel === "all" ? [] : ids };
}

// ---------------------------------------------------------------- developer mutations

function readInput(body: unknown, partial: boolean): Partial<IntegrationInput> | MockResponse {
  const b = (typeof body === "object" && body !== null ? body : {}) as Partial<IntegrationInput>;
  if (!partial || b.name !== undefined) {
    if (typeof b.name !== "string" || b.name.trim().length < 2) {
      return fail(
        400,
        "invalid-request",
        "name is required",
        "Give the integration a name people will recognise, 2 to 60 characters.",
      );
    }
  }
  if (!partial || b.redirectUris !== undefined) {
    if (!Array.isArray(b.redirectUris) || b.redirectUris.length === 0) {
      return fail(
        400,
        "invalid-request",
        "at least one redirect URI is required",
        "Add the exact callback URL your OAuth flow returns to.",
      );
    }
  }
  if (!partial || b.scopes !== undefined) {
    if (!Array.isArray(b.scopes) || b.scopes.length === 0) {
      return fail(
        400,
        "invalid-request",
        "pick at least one permission",
        "Deploy platforms usually need the first four.",
      );
    }
  }
  if (b.webhook?.url && !b.scopes?.includes("webhooks") && !partial) {
    return fail(
      400,
      "invalid-request",
      "a webhook needs the webhooks permission",
      "Tick Receive events, or leave the webhook URL empty.",
    );
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
    clientId: `gtic_${sha(id).slice(0, 10)}`,
    name: i.name.trim(),
    description: i.description ?? null,
    logoUrl: i.logoUrl ?? null,
    homepageUrl: i.homepageUrl,
    redirectUris: i.redirectUris,
    clientType: confidential ? "confidential" : "public",
    scopes: i.scopes,
    scopesExplained: explain(i.scopes),
    developer: { name: ME.name },
    webhook: {
      url: hookUrl,
      active: i.webhook?.active ?? true,
      events: i.webhook?.events ?? [],
      secretSet: Boolean(hookUrl),
    },
    secrets: secret
      ? [
          {
            id: `sec_${b64u(id, 8)}`,
            prefix: secret.slice(0, 12),
            createdAt: now,
            lastUsedAt: null,
          },
        ]
      : [],
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
  if (p.scopes !== undefined) {
    it.scopes = p.scopes;
    it.scopesExplained = explain(p.scopes);
  }
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

function queueDelivery(
  it: IntegrationView,
  event: WebhookEvent,
  redeliveryOf: DeliveryDetail | null,
): DeliveryDetail {
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
  // A redelivery is a new row with the original's body and guid (X-Gittifacts-Delivery stays the same).
  if (redeliveryOf) {
    d.payload = redeliveryOf.payload;
    d.guid = redeliveryOf.guid;
    d.requestHeaders = { ...redeliveryOf.requestHeaders };
  }
  deliveries.unshift(d);
  // The mock receiver answers a moment later: pings and redeliveries succeed while the hook is active.
  setTimeout(() => {
    Object.assign(
      d,
      it.webhook.active
        ? {
            status: "delivered",
            attempts: 1,
            responseStatus: 200,
            durationMs: 163,
            lastAttemptAt: new Date().toISOString(),
            responseBody: '{"ok":true}',
          }
        : { status: "cancelled", error: "webhook disabled" },
    );
  }, 1500);
  return d;
}

// ---------------------------------------------------------------- router

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const notFound = (what: string) =>
  fail(404, "not-found", `no such ${what}`, "Reload the list; it may have been deleted.");

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
      return fail(
        404,
        "install-request-not-found",
        "this installation request doesn't exist",
        "Start the connection again from the integration's site. Requests last 10 minutes.",
      );
    }
    if (method === "GET" && !m[2]) return ok({ install: view });
    if (method !== "POST") return notFound("route");
    if (view.status !== "pending") {
      return fail(
        409,
        "install-request-decided",
        `this request was already ${view.status}`,
        `Go back to ${view.integration.name} and connect again for a new request.`,
      );
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
    return ok({
      redirectTo: `${back}?code=mock-code&state=mock&installation_id=${view.existing?.installationId ?? "new"}`,
    });
  }

  // installed integrations
  if (p === "/api/v1/installations" && method === "GET") {
    return ok({ installations: installations.filter((i) => i.status === "active") });
  }
  m = /^\/api\/v1\/installations\/([^/]+)(\/uninstall)?$/.exec(p);
  if (m) {
    const inst = installations.find(
      (i) => i.id === decodeURIComponent(m?.[1] ?? "") && i.status === "active",
    );
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
      inst.repos =
        sel.repoSelection === "all" ? REPOS.map((r) => ({ ...r })) : sel.repoIds.map(repo);
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
        return fail(
          409,
          "invalid-state",
          "public clients have no secret",
          "Public clients prove themselves with PKCE. Switch to confidential to use a secret.",
        );
      }
      const id = nextId("sec");
      const clientSecret = secretValue(id);
      const secret: SecretView = {
        id,
        prefix: clientSecret.slice(0, 12),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      it.secrets.unshift(secret);
      return ok({ clientSecret, secret, integration: it }, 201);
    }
    const sm = /^secrets\/([^/]+)$/.exec(rest);
    if (sm && method === "DELETE") {
      const idx = it.secrets.findIndex((s) => s.id === decodeURIComponent(sm[1] ?? ""));
      if (idx < 0) return notFound("secret");
      if (it.secrets.length === 1) {
        // Exactly `last-secret`: the only active client secret can't be revoked.
        return fail(
          409,
          "last-secret",
          "can't revoke the only secret",
          "Generate a new secret first, deploy it, then revoke this one.",
        );
      }
      it.secrets.splice(idx, 1);
      return ok({ integration: it });
    }
    if (rest === "webhook-secret" && method === "POST") {
      it.webhook.secretSet = true;
      return ok({ webhookSecret: `whsec_${b64u(nextId("wh"), 32)}`, integration: it });
    }
    if (rest === "ping" && method === "POST") {
      if (!it.webhook.url)
        return fail(
          409,
          "no-webhook",
          "no webhook URL is set",
          "Add a webhook URL first, then send a ping.",
        );
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
      const d = deliveries.find(
        (x) => x.id === decodeURIComponent(dm[1] ?? "") && deliveryOwner(x) === it.id,
      );
      if (!d) return notFound("delivery");
      if (method === "GET" && !dm[2]) return ok({ delivery: d });
      if (method === "POST" && dm[2])
        return ok({ delivery: summary(queueDelivery(it, d.event, d)) }, 202);
    }
  }
  return fail(404, "not-found", `No mock route for ${method} ${p}.`, "Reload the page.");
}
