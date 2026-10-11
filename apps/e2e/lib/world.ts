/**
 * Test data for the pre-deploy gate: a fresh human signed up through the real better-auth routes,
 * and (optionally) a review-ready world seeded by the local server's `/__e2e/seed`
 * (apps/platform/test/e2e-seed.ts). Every call makes new, uniquely named data.
 */
import type { APIRequestContext, BrowserContext } from "@playwright/test";
import { uniqueName } from "./poll.js";

export const SEED_TOKEN = process.env.E2E_SEED_TOKEN ?? "e2e-local-seed-token";

export interface Human {
  email: string;
  password: string;
  name: string;
  principalId: string;
  /** `better-auth.session_token=…` (name=value only). */
  cookie: string;
}

export interface World {
  repoId: string;
  repoName: string;
  agentId: string;
  planId: string;
  changeId: string;
}

export async function signUp(
  request: APIRequestContext,
  baseURL: string,
  label = "human",
): Promise<Human> {
  const name = uniqueName(label);
  const email = `${name}@e2e.invalid`;
  const password = `pw-${name}-correct-horse`;
  const res = await request.post(`${baseURL}/api/auth/sign-up/email`, {
    data: { email, password, name },
    headers: { origin: baseURL },
  });
  if (!res.ok()) throw new Error(`sign-up failed: ${res.status()} ${await res.text()}`);
  const setCookie = res
    .headersArray()
    .find(
      (h) =>
        h.name.toLowerCase() === "set-cookie" && h.value.includes("better-auth.session_token="),
    );
  if (setCookie === undefined) throw new Error("sign-up set no session cookie");
  const cookie = setCookie.value.split(";")[0] as string;
  const me = await request.get(`${baseURL}/api/v1/me`, { headers: { cookie } });
  if (!me.ok()) throw new Error(`/api/v1/me after sign-up: ${me.status()}`);
  const { principal } = (await me.json()) as { principal: { id: string } };
  return { email, password, name, principalId: principal.id, cookie };
}

export async function seedWorld(
  request: APIRequestContext,
  baseURL: string,
  human: Human,
  label = "e2e",
): Promise<World> {
  const res = await request.post(`${baseURL}/__e2e/seed`, {
    data: { principalId: human.principalId, label },
    headers: { "x-e2e-seed": SEED_TOKEN },
  });
  if (res.status() !== 201) throw new Error(`seed failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as World;
}

/** Puts the human's session cookie into a browser context (signed in, no UI round trip). */
export async function signInContext(
  context: BrowserContext,
  baseURL: string,
  human: Human,
): Promise<void> {
  const [name, ...rest] = human.cookie.split("=");
  await context.addCookies([
    { name: name as string, value: rest.join("="), url: baseURL, httpOnly: true, sameSite: "Lax" },
  ]);
}

export async function seedCall<T>(
  request: APIRequestContext,
  baseURL: string,
  path: string,
  data: unknown,
): Promise<T> {
  const res = await request.post(`${baseURL}${path}`, {
    data,
    headers: { "x-e2e-seed": SEED_TOKEN },
  });
  if (res.status() >= 300) throw new Error(`${path}: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

export interface AgentChange {
  repoId: string;
  repoName: string;
  agentToken: string;
  changeId: string;
  head: string;
}

/**
 * An agent's Change through the real pipeline, as in the workerd M1 test but over HTTP against
 * the served Worker: the human creates a repo and an agent token, the agent starts a Change
 * (POST /api/v1/changes) and pushes to its fork, CI finishes, and the ChangeWorkflow classifies
 * it, has the reviewer agent write the walkthrough and asks for review. Only Artifacts, the CI
 * container and the model are fakes.
 */
export async function agentChange(
  request: APIRequestContext,
  baseURL: string,
  human: Human,
  poll: <T>(probe: () => Promise<T>, done: (v: T) => boolean, what: string) => Promise<T>,
): Promise<AgentChange> {
  const headers = { cookie: human.cookie, origin: baseURL };
  const repoName = uniqueName("pipe").toLowerCase();
  const created = await request.post(`${baseURL}/api/v1/repos`, {
    headers,
    data: { name: repoName },
  });
  if (created.status() !== 201)
    throw new Error(`create repo: ${created.status()} ${await created.text()}`);
  const { repo } = (await created.json()) as { repo: { id: string; artifactsName: string } };
  await seedCall(request, baseURL, "/__e2e/git/seed", { artifactsName: repo.artifactsName });
  const agentRes = await request.post(`${baseURL}/api/v1/principals/agents`, {
    headers,
    data: {
      name: uniqueName("agent").toLowerCase(),
      scopes: ["repo:read", "plan:create", "change:create"],
    },
  });
  if (agentRes.status() !== 201)
    throw new Error(`create agent: ${agentRes.status()} ${await agentRes.text()}`);
  const { token } = (await agentRes.json()) as { token: string };
  const auth = { authorization: `Bearer ${token}`, origin: baseURL };
  const started = await request.post(`${baseURL}/api/v1/changes`, {
    headers: auth,
    data: { repoId: repo.id, title: "Fix the off-by-one in a()", category: "fix" },
  });
  if (started.status() !== 201)
    throw new Error(`start change: ${started.status()} ${await started.text()}`);
  const { change } = (await started.json()) as { change: { id: string } };
  const { head } = await seedCall<{ head: string }>(request, baseURL, "/__e2e/git/push", {
    forkName: `task-${change.id}`,
    files: {
      "src/a.ts": "export const a = (x: number) => x + 2;\n",
      "test/a.test.ts": 'import { a } from "../src/a";\n// adds a regression test\n',
    },
  });
  await poll(
    () =>
      seedCall<{ finished: string[] }>(request, baseURL, "/__e2e/ci/finish", {
        changeId: change.id,
      }),
    (r) => r.finished.length > 0,
    "CI to start for the pushed head",
  );
  await poll(
    async () => {
      const res = await request.get(`${baseURL}/api/v1/changes/${change.id}`, { headers: auth });
      return ((await res.json()) as { change: { status: string } }).change.status;
    },
    (status) => status === "awaiting-review",
    "the Change to await review",
  );
  return { repoId: repo.id, repoName, agentToken: token, changeId: change.id, head };
}
