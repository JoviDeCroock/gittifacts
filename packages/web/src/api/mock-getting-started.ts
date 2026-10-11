/**
 * Mock backend for the dashboard checklist (the golden path). `?mock&gs=new` is a brand-new
 * account (no repos, no agent), `?mock&gs=partial` has repos and an agent and a sample plan to
 * approve; otherwise all five steps are done. "Create repo" makes a project whose first run goes
 * green after a few seconds, with a preview link and its sample plan to approve.
 * The scenario is remembered for the tab, like `?mock` itself.
 */
import { GITHUB_SURFACES } from "@app/domain/surfaces";
import type { GettingStarted, ProjectCreated } from "./getting-started.js";

export interface MockResponse {
  status: number;
  body: unknown;
}

type Scenario = "new" | "partial" | "done";
const KEY = "gf:mock-gs";
/** How long the mock's first run takes to go green. */
const RUN_MS = 6000;

function scenario(): Scenario {
  if (typeof window === "undefined") return "done";
  try {
    const q = new URLSearchParams(window.location.search).get("gs");
    if (q === "new" || q === "partial" || q === "done") window.sessionStorage.setItem(KEY, q);
    const v = window.sessionStorage.getItem(KEY);
    return v === "new" || v === "partial" ? v : "done";
  } catch {
    return "done";
  }
}

/** A brand-new account in mock mode: the repository list starts empty (see mock.ts). */
export function mockFreshAccount(): boolean {
  return scenario() === "new";
}

interface Created {
  id: string;
  name: string;
  template: string;
  changeId: string;
  createdAt: number;
}
const created: Created[] = [];

/** Projects "Try it now" made in this tab (mock.ts lists them on a fresh account). */
export function mockCreatedProjects(): readonly { id: string; name: string; template: string }[] {
  return created;
}

function previewUrl(changeId: string): string {
  return `https://p-${changeId}-pv.example.dev`;
}

function samplePlan(repoId: string, repoName: string, approved: boolean): GettingStarted["plan"] {
  return {
    approved,
    planId: `plan_sample_${repoId}`,
    title: "Add GET /version",
    status: approved ? "approved" : "draft",
    repoId,
    repoName,
    sample: true,
  };
}

function state(): GettingStarted {
  const s = scenario();
  const now = Date.now();
  const latest = created[created.length - 1];
  const greenOne = created.find((c) => now - c.createdAt >= RUN_MS);
  const demoGreen: GettingStarted["firstGreen"] = {
    projectId: "r_billing",
    projectName: "billing-api",
    changeId: "chdemo1",
    previewUrl: previewUrl("chdemo1"),
    at: new Date(now - 86_400_000).toISOString(),
    msToFirstGreen: 41_000,
  };
  return {
    projects: (s === "new" ? 0 : 4) + created.length,
    agent:
      s === "new" ? { connected: false, name: null } : { connected: true, name: "fleet-coder-07" },
    firstGreen: greenOne
      ? {
          projectId: greenOne.id,
          projectName: greenOne.name,
          changeId: greenOne.changeId,
          previewUrl: previewUrl(greenOne.changeId),
          at: new Date(greenOne.createdAt + RUN_MS).toISOString(),
          msToFirstGreen: RUN_MS,
        }
      : s === "done"
        ? demoGreen
        : null,
    latestBootstrap: latest
      ? {
          projectId: latest.id,
          projectName: latest.name,
          template: latest.template,
          changeId: latest.changeId,
          previewUrl: previewUrl(latest.changeId),
          createdAt: new Date(latest.createdAt).toISOString(),
          status: now - latest.createdAt >= RUN_MS ? "green" : "running",
          msToFirstGreen: now - latest.createdAt >= RUN_MS ? RUN_MS : null,
        }
      : null,
    repo: s === "done" ? { connected: true, via: GITHUB_SURFACES ? "github-app" : "import" } : { connected: false, via: null },
    plan: latest
      ? samplePlan(latest.id, latest.name, false)
      : s === "new"
        ? null
        : samplePlan("r_billing", "billing-api", s === "done"),
    review:
      s === "done"
        ? { approved: true, changeId: "chdemo2", title: "Add GET /version", status: "merged", repoId: "r_billing" }
        : null,
    firstMerge:
      s === "done" && latest === undefined
        ? {
            projectId: "r_billing",
            projectName: "billing-api",
            changeId: "chdemo2",
            title: "Add GET /version",
            at: new Date(now - 82_800_000).toISOString(),
            msToFirstMerge: 342_000,
          }
        : null,
  };
}

export async function handle(method: string, path: string, body?: unknown): Promise<MockResponse> {
  await new Promise((r) => setTimeout(r, method === "GET" ? 120 : 480));
  const url = new URL(path, "https://mock.invalid");
  if (method === "GET" && url.pathname === "/api/v1/me/getting-started") {
    return { status: 200, body: state() };
  }
  if (method === "POST" && url.pathname === "/api/v1/projects") {
    const input = (typeof body === "object" && body !== null ? body : {}) as { template?: string };
    const template = input.template ?? "workers-api";
    const n = created.length + 1;
    const c: Created = {
      id: `r_try${n}`,
      name: `${template}-${String(n).padStart(2, "0")}`,
      template,
      changeId: `chtry${n}`,
      createdAt: Date.now(),
    };
    created.push(c);
    const out: ProjectCreated = {
      projectId: c.id,
      name: c.name,
      template,
      previewUrl: previewUrl(c.changeId),
      bootstrapChangeId: c.changeId,
      samplePlanId: `plan_sample_${c.id}`,
    };
    return { status: 201, body: out };
  }
  return {
    status: 404,
    body: { error: { code: "not_found", message: `No mock route for ${method} ${url.pathname}.` } },
  };
}
