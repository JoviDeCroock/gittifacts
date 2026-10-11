/**
 * The dashboard's first-run checklist: its state (`GET /api/v1/me/getting-started`) and the one
 * write it makes, creating a project from a template (`POST /api/v1/projects`). In mock mode the
 * calls go to ./mock-getting-started.ts.
 */
import { ApiError, type Method, newIdempotencyKey, request } from "./client.js";
import { isMockMode } from "./mode.js";

export type BootstrapStatus = "running" | "green" | "ci-failed" | "preview-failed" | "no-preview";

export interface GettingStarted {
  projects: number;
  agent: { connected: boolean; name: string | null };
  firstGreen: {
    projectId: string;
    projectName: string;
    changeId: string;
    previewUrl: string | null;
    at: string | null;
    msToFirstGreen: number | null;
  } | null;
  latestBootstrap: {
    projectId: string;
    projectName: string;
    template: string | null;
    changeId: string | null;
    previewUrl: string | null;
    createdAt: string;
    status: BootstrapStatus;
    msToFirstGreen: number | null;
  } | null;
  repo: { connected: boolean; via: "import" | "github-mirror" | "github-app" | null };
  /** The Plan you approved, else the one to approve (a template repo's sample Plan first). */
  plan: {
    approved: boolean;
    planId: string;
    title: string;
    status: "draft" | "approved" | "superseded" | "rejected";
    repoId: string;
    repoName: string;
    sample: boolean;
  } | null;
  /** The Change you approved, else the newest one waiting for review. */
  review: {
    approved: boolean;
    changeId: string;
    title: string;
    status: string;
    repoId: string;
  } | null;
  /** The first Change the merge queue landed in your repos. */
  firstMerge: {
    projectId: string;
    projectName: string;
    changeId: string;
    title: string;
    at: string | null;
    msToFirstMerge: number | null;
  } | null;
}

export interface ProjectCreated {
  projectId: string;
  name: string;
  template: string | null;
  previewUrl: string | null;
  bootstrapChangeId: string | null;
  samplePlanId?: string | null;
}

export const GETTING_STARTED_PATH = "/api/v1/me/getting-started";

async function call<T>(method: Method, path: string, body?: unknown, key?: string): Promise<T> {
  if (!isMockMode()) return request<T>(method, path, body, key);
  const mock = await import("./mock-getting-started.js");
  const res = await mock.handle(method, path, body);
  if (res.status >= 200 && res.status < 300) return res.body as T;
  throw new ApiError(res.status, `http_${res.status}`, `The server answered ${res.status}.`);
}

export const gettingStartedApi = {
  state: () => call<GettingStarted>("GET", GETTING_STARTED_PATH),
  /** One key per click: a retry of the same click returns the same project. */
  createProject: (input: { template?: string; from?: string }, key = newIdempotencyKey()) =>
    call<ProjectCreated>("POST", "/api/v1/projects", input, key),
};
