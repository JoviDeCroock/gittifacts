/**
 * GitHub mode (docs/prompts/06-two-modes.md §3): the platform's GitHub App (from Worker config)
 * and the installations you linked. In mock mode the calls go to ./mock-github.ts.
 */
import { ApiError, type Method, request } from "./client.js";
import { isMockMode } from "./mode.js";

/** The platform's GitHub App, registered by hand and read from Worker config. */
export interface GithubApp {
  id: number;
  slug: string;
  htmlUrl: string;
  installUrl: string;
}

export interface GithubInstallation {
  id: number;
  appId: number;
  account: { login: string; type: string };
  repositorySelection: string;
  suspended: boolean;
  repos: {
    id: number;
    fullName: string;
    private: boolean;
    repoId: string | null;
    prWrites: "on" | "off";
  }[];
  linkedAs: string;
  linkedAt: string;
  manageUrl: string;
}

export interface GithubOverview {
  /** null while GitHub mode isn't configured on this platform. */
  app: GithubApp | null;
  /** Config names still missing (never values). */
  missing: string[];
  installations: GithubInstallation[];
  webhookUrl: string;
}

async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (!isMockMode()) return request<T>(method, path, body);
  const mock = await import("./mock-github.js");
  const res = await mock.handle(method, path, body);
  if (res.status >= 200 && res.status < 300) return res.body as T;
  throw new ApiError(res.status, `http_${res.status}`, `The server answered ${res.status}.`);
}

/** The parts of a backtest report the UI shows (packages/host-github/src/backtest/report.ts). */
export interface BacktestReportView {
  window: { since: string; until: string; days: number };
  listed: number;
  graded: number;
  wouldAutoMerge: { count: number; percent: number };
  afterwards: {
    reverted: { number: number; by: number }[];
    patched: { number: number; by: number }[];
    unknown: number;
  };
  fastFullReviews: { number: number; title: string; hoursToMerge: number; reasons: string[] }[];
  calibration: {
    samples: number;
    candidates: number;
    bad: number;
    eligible: boolean;
    reason: string;
  };
}

export interface BacktestView {
  id: string;
  status: "running" | "done" | "failed";
  maxPrs: number;
  report: BacktestReportView | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export const githubApi = {
  latestBacktest: (repoId: string) =>
    call<{ backtest: BacktestView | null }>(
      "GET",
      `/api/v1/github/repos/${encodeURIComponent(repoId)}/backtests/latest`,
    ),
  startBacktest: (repoId: string) =>
    call<{ id: string; started: boolean }>(
      "POST",
      `/api/v1/github/repos/${encodeURIComponent(repoId)}/backtests`,
      {},
    ),
  overview: () => call<GithubOverview>("GET", "/api/v1/github"),
  setPrWrites: (repoId: string, value: "on" | "off") =>
    call<{ repoId: string; prWrites: "on" | "off" }>(
      "PUT",
      `/api/v1/github/repos/${encodeURIComponent(repoId)}/pr-writes`,
      { value },
    ),
};

/** What a `?error=` code on /settings/github means, in plain words. */
export const FLOW_ERRORS: Record<string, string> = {
  "not-configured":
    "GitHub mode isn't set up on this platform yet, so the installation wasn't linked.",
  "state-expired":
    "That step expired (links are good for ten minutes). Open the installation on GitHub and try again.",
  "state-not-yours":
    "That step was started by someone else. Start again while signed in as yourself.",
  "state-not-this-browser": "That step was started in another browser. Start again here.",
  "code-missing": "GitHub didn't send a code back. Start again.",
  "installation-missing":
    "GitHub didn't say which installation this is. Open the App's page on GitHub and install it again.",
  "installation-not-yours": "Your GitHub account can't see that installation, so it wasn't linked.",
  "authorization-denied":
    "You cancelled the authorization on GitHub, so the installation wasn't linked.",
  "authorization-failed": "GitHub refused the authorization code. Try again.",
  "github-error": "GitHub answered with an error. Try again in a minute.",
  internal: "Something went wrong on our side. Try again.",
};
