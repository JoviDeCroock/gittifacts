/** Shared by the import-by-push integration tests (src/import/push-grant.ts). */
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { call, json, type TestApp } from "../http.js";
import { NAMESPACE } from "./fakes.js";

export interface PushProject {
  projectId: string;
  name: string;
  remote: unknown;
  bootstrapChangeId: string | null;
  importGrant: {
    url: string;
    branch: string;
    token: string;
    expiresAt: string;
    command: string;
    closesWhen: string;
  };
  nextSteps: { title: string; command?: string }[];
}

export interface GrantStatus {
  status: "open" | "closing" | "closed";
  closeReason: string | null;
  mainSha: string | null;
  imported: boolean;
  openedBy: string;
}

export async function createPushProject(app: TestApp, cookie: string): Promise<PushProject> {
  const res = await call(app, "POST", "/api/v1/projects", {
    cookie,
    body: { name: `imp-${crypto.randomUUID().slice(0, 8)}`, importMode: "push" },
  });
  expect(res.status).toBe(201);
  return json<PushProject>(res);
}

export async function grantStatus(
  app: TestApp,
  cookie: string,
  repoId: string,
): Promise<GrantStatus | null> {
  const res = await call(app, "GET", `/api/v1/repos/${repoId}/import-grant`, { cookie });
  expect(res.status).toBe(200);
  return (await json<{ grant: GrantStatus | null }>(res)).grant;
}

/** What Artifacts sends after a push to `repoName` (the PushRouter's trigger payload). */
export async function deliverPush(repoName: string, ref: string, after: string): Promise<void> {
  await env.PUSH_ROUTER.create({
    id: `push-${repoName}-${after.slice(0, 12)}`,
    params: {
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: NAMESPACE, repoName },
      payload: { ref, before: "0".repeat(40), after },
    },
  });
}

/** Poll until `done` holds (workflows run in the background). */
export async function eventually<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  tries = 60,
): Promise<T> {
  let v = await read();
  for (let i = 0; i < tries && !done(v); i++) {
    await new Promise((r) => setTimeout(r, 50));
    v = await read();
  }
  return v;
}

export async function auditActions(
  app: TestApp,
  cookie: string,
  repoId: string,
): Promise<{ action: string; principalId: string }[]> {
  const res = await call(app, "GET", `/api/v1/audit?subject=repo:${repoId}&limit=200`, { cookie });
  expect(res.status).toBe(200);
  return (await json<{ events: { action: string; principalId: string }[] }>(res)).events;
}
