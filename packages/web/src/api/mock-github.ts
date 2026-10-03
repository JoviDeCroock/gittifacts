/**
 * Mock backend for /settings/github. `?mock&gh=empty` shows the page before the App exists;
 * otherwise one Reader App with one linked installation on a test org.
 */
import { ago } from "./fixture-kit.js";
import type { GithubOverview, ManifestStart } from "./github.js";

export interface MockResponse {
  status: number;
  body: unknown;
}

function scenario(): "empty" | "installed" {
  if (typeof window === "undefined") return "installed";
  return new URLSearchParams(window.location.search).get("gh") === "empty" ? "empty" : "installed";
}

function overview(): GithubOverview {
  const origin = typeof window === "undefined" ? "https://gittifacts.dev" : window.location.origin;
  const base = { canCreateApps: true, actorAppsEnabled: false, webhookUrl: `${origin}/github/webhooks` };
  if (scenario() === "empty") return { ...base, apps: [], installations: [] };
  return {
    ...base,
    apps: [
      {
        id: 1180001,
        kind: "reader",
        slug: "gittifacts",
        name: "gittifacts",
        owner: { login: "maya-okafor", type: "User" },
        htmlUrl: "https://github.com/apps/gittifacts",
        installUrl: "https://github.com/apps/gittifacts/installations/new",
        permissions: {
          metadata: "read", contents: "read", pull_requests: "write", checks: "write", issues: "read",
          merge_queues: "read", deployments: "read", statuses: "read",
        },
        events: ["pull_request", "pull_request_review", "push", "merge_group", "check_run"],
        createdAt: ago(180),
      },
    ],
    installations: [
      {
        id: 51234567,
        appId: 1180001,
        account: { login: "gittifacts-test", type: "Organization" },
        repositorySelection: "selected",
        suspended: false,
        repos: [
          { id: 9001, fullName: "gittifacts-test/pure-bugfix", private: true, repoId: "gh-9001", prWrites: "on" },
          { id: 9002, fullName: "gittifacts-test/clock-api", private: false, repoId: null, prWrites: "on" },
        ],
        linkedAs: "maya-okafor",
        linkedAt: ago(120),
        manageUrl: "https://github.com/organizations/gittifacts-test/settings/installations/51234567",
      },
    ],
  };
}

function mockBacktest() {
  return {
    id: "bt-31337-mock",
    status: "done",
    maxPrs: 24,
    error: null,
    createdAt: ago(40),
    finishedAt: ago(26),
    report: {
      window: { since: ago(90 * 24 * 60), until: ago(40), days: 90 },
      listed: 61,
      graded: 24,
      wouldAutoMerge: { count: 9, percent: 37.5 },
      afterwards: { reverted: [], patched: [{ number: 412, by: 419 }], unknown: 0 },
      fastFullReviews: [
        { number: 433, title: "Swap the session store for Durable Objects", hoursToMerge: 0.8, reasons: ["sensitive.auth"] },
        { number: 401, title: "Drop the v1 export endpoint", hoursToMerge: 2.5, reasons: ["api.breaking"] },
      ],
      calibration: { samples: 24, candidates: 9, bad: 1, eligible: false, reason: "only 24 graded PRs with a known outcome (needs 25)" },
    },
  };
}

export async function handle(method: string, path: string, body?: unknown): Promise<MockResponse> {
  if (method === "GET" && path === "/api/v1/github") return { status: 200, body: overview() };
  if (method === "POST" && path === "/api/v1/github/manifests") {
    const input = (body ?? {}) as { org?: string; name?: string };
    const out: ManifestStart = {
      kind: "reader",
      name: input.name || "gittifacts",
      org: input.org || null,
      action: "https://github.com/settings/apps/new?state=mock",
      manifest: "{}",
      state: "mock",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    return { status: 200, body: out };
  }
  if (method === "GET" && /\/backtests\/latest$/.test(path)) return { status: 200, body: { backtest: mockBacktest() } };
  if (method === "POST" && /\/backtests$/.test(path)) return { status: 202, body: { id: "bt-mock", started: true } };
  const m = /^\/api\/v1\/github\/repos\/([^/]+)\/pr-writes$/.exec(path);
  if (method === "PUT" && m) return { status: 200, body: { repoId: decodeURIComponent(m[1] ?? ""), prWrites: (body as { value: string }).value } };
  return { status: 404, body: { error: { code: "not-found", message: "no such route", fix: { explanation: "" } } } };
}
