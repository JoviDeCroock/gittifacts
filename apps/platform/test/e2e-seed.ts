/**
 * `POST /__e2e/seed` for the pre-deploy browser E2E (apps/e2e). Only test/e2e-entry.ts routes
 * here, and only with the `x-e2e-seed` header equal to the E2E_SEED_TOKEN secret: production never
 * bundles this file.
 *
 * `/__e2e/seed`: given a signed-up human, writes one review-ready world through the real D1Store (the same
 * fixtures the workerd route tests use): an agent the human owns, a repo the human owns, a draft
 * Plan the agent proposed (waiting for the human), and a Lane 1 Change by the agent with a diff,
 * signed evidence, a passed run, its classification and a walkthrough. Every id is unique, so
 * tests never share data.
 */
import { env } from "cloudflare:workers";
import { FakeLlmClient } from "@app/tour";
import { z } from "zod";
import {
  addMember,
  changeFixture,
  classificationFixture,
  diffFixture,
  evidenceFixture,
  HEAD_SHA,
  planFixture,
  repoFixture,
  runFixture,
  seedPrincipal,
  store,
  tourFixture,
  uid,
} from "./fixtures.js";
import { type CiSinkEnv, integrationFakes, NAMESPACE } from "./integration/fakes.js";
import { qaFakes } from "./integration/qa-fakes.js";

const SeedInput = z.object({
  principalId: z.string().min(1),
  /** Distinguishes this test's data in names (Playwright's test id). */
  label: z.string().max(40).default("e2e"),
});

export interface SeedResult {
  repoId: string;
  repoName: string;
  agentId: string;
  planId: string;
  changeId: string;
}

async function seed(input: z.infer<typeof SeedInput>): Promise<SeedResult> {
  const s = store();
  const human = await s.getPrincipal(input.principalId);
  if (human === null || human.kind !== "human") throw new Error("principalId is not a human");
  const agentId = await seedPrincipal(s, {
    kind: "agent",
    name: `${input.label}-bot`,
    ownerId: human.id,
    scopes: ["repo:read", "plan:create", "change:create"],
  });
  const slug = input.label.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const repo = repoFixture({
    name: `${slug}-${uid("r").slice(2)}`,
    claim: { status: "claimed", ownerId: human.id, expiresAt: null },
  });
  await s.insertRepo(repo, human.id);
  // The repo's git side lives in the entry's FakeGitHost (Artifacts is remote-only): a first commit.
  integrationFakes().git.seed(repo.artifactsName, {
    "package.json": '{ "name": "e2e", "scripts": { "test": "vitest run" } }\n',
    "src/auth/login.ts": "export function login() {\n  return ok();\n}\n",
  });
  await addMember(s, repo.id, human.id, "owner");
  const plan = planFixture(repo.id, agentId, { title: "Rate limit the login endpoint" });
  await s.insertPlan(plan);
  const change = changeFixture(repo.id, agentId, { title: "Rate limit logins" });
  await s.insertChange(change);
  await s.putDiff(change.id, diffFixture());
  await s.upsertRun(runFixture(change.id));
  await s.putClassification(change.id, HEAD_SHA, classificationFixture());
  const ev = await evidenceFixture(change.id);
  await s.putEvidence(ev);
  const tour = tourFixture(change.id);
  await s.putTour(tour);
  await s.updateChange(change.id, { evidenceId: ev.id, tourId: tour.id });
  return { repoId: repo.id, repoName: repo.name, agentId, planId: plan.id, changeId: change.id };
}

const GitSeedInput = z.object({
  artifactsName: z.string().min(1),
  files: z.record(z.string(), z.string()).optional(),
});
const PushInput = z.object({
  forkName: z.string().min(1),
  branch: z.string().default("main"),
  files: z.record(z.string(), z.string().nullable()),
});
const FinishInput = z.object({ changeId: z.string().min(1) });

const DEFAULT_FILES = {
  "package.json": '{ "name": "e2e", "scripts": { "test": "vitest run" } }\n',
  "src/a.ts": "export const a = (x: number) => x + 1;\n",
  "test/a.test.ts": 'import { a } from "../src/a";\n',
};

/**
 * The parts of an agent's journey that happen outside the Worker, done the way the fakes stand in
 * for them in the workerd M1 test: a repo's first commit (Artifacts), a push to a Change's fork
 * (Artifacts + the cf.artifacts.repo.pushed event), and CI finishing (the Runner container).
 */
async function pipeline(path: string, body: unknown): Promise<Response> {
  const fakes = integrationFakes();
  if (path === "/__e2e/qa/script") {
    // A Plan with these criteria on the Change, and the model's next answers for QA (qa-fakes.ts).
    const input = z
      .object({
        changeId: z.string().min(1),
        criteria: z.array(z.string().min(1)).min(1),
        responses: z.array(z.unknown()),
      })
      .parse(body);
    const s = store();
    const change = await s.getChange(input.changeId);
    if (change === null) return Response.json({ error: "no such change" }, { status: 404 });
    const plan = planFixture(change.repoId, change.authorId, {
      acceptanceCriteria: input.criteria,
      affectedRoutes: ["/"],
      status: "approved",
    });
    await s.insertPlan(plan);
    await s.updateChange(change.id, { planId: plan.id });
    qaFakes().llm = new FakeLlmClient(
      input.responses.map((json) => ({ json })),
      { defaultCostUsd: 0.0005 },
    );
    return Response.json({ planId: plan.id }, { status: 201 });
  }
  if (path === "/__e2e/qa/fail") {
    // QA's HTML browser answers 500 for this Change's app: the smoke check fails (qa-fakes.ts).
    const { changeId } = z.object({ changeId: z.string().min(1) }).parse(body);
    qaFakes().failChanges.add(changeId);
    return Response.json({ ok: true }, { status: 201 });
  }
  if (path === "/__e2e/git/seed") {
    const input = GitSeedInput.parse(body);
    const sha = fakes.git.seed(input.artifactsName, input.files ?? DEFAULT_FILES);
    return Response.json({ sha }, { status: 201 });
  }
  if (path === "/__e2e/git/push") {
    const input = PushInput.parse(body);
    const before = (await fakes.git.branchHead(input.forkName, input.branch)) ?? "0".repeat(40);
    const head = fakes.git.commit(input.forkName, input.branch, input.files, "e2e push");
    const bindings = env as unknown as { PUSH_ROUTER: Workflow };
    await bindings.PUSH_ROUTER.create({
      id: `push-${head}`,
      params: {
        type: "cf.artifacts.repo.pushed",
        source: { type: "artifacts.repo", namespace: NAMESPACE, repoName: input.forkName },
        payload: { ref: `refs/heads/${input.branch}`, before, after: head },
      },
    });
    return Response.json({ head }, { status: 201 });
  }
  if (path === "/__e2e/ci/finish") {
    const { changeId } = FinishInput.parse(body);
    const finished: string[] = [];
    for (const [runId, run] of fakes.ci.runs) {
      if (run.request.changeId === changeId && run.status.status === "running") {
        await fakes.ci.finish(env as unknown as CiSinkEnv, runId);
        finished.push(runId);
      }
    }
    return Response.json({ finished }, { status: 200 });
  }
  return new Response("not found", { status: 404 });
}

export async function handleE2eSeed(request: Request): Promise<Response> {
  const secret = (env as unknown as { E2E_SEED_TOKEN?: string }).E2E_SEED_TOKEN ?? "";
  if (secret === "" || request.headers.get("x-e2e-seed") !== secret || request.method !== "POST") {
    return new Response("not found", { status: 404 });
  }
  const path = new URL(request.url).pathname;
  const body = await request.json().catch(() => null);
  try {
    if (path !== "/__e2e/seed") return await pipeline(path, body);
    const parsed = SeedInput.safeParse(body);
    if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
    return Response.json(await seed(parsed.data), { status: 201 });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: err instanceof z.ZodError ? 400 : 500 });
  }
}
