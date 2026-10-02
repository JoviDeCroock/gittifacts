/**
 * Shared setup for the repo-access tests: Alice owns a repo with a plan, a change (diff, evidence,
 * tour, classification, run, CI log blob) and an audit event; Bob and his agent are strangers.
 */
import { env } from "cloudflare:workers";
import { DoAudit } from "../src/audit/audit.js";
import {
  changeFixture,
  classificationFixture,
  diffFixture,
  evidenceFixture,
  planFixture,
  repoFixture,
  runFixture,
  store,
  tourFixture,
} from "./fixtures.js";
import { call, createAgent, makeApp, signUpHuman, type TestApp } from "./http.js";

export async function world(coordinator: Parameters<typeof makeApp>[0] = {}) {
  const { app, coordinator: mock } = makeApp(coordinator);
  const alice = await signUpHuman(app, "Alice");
  const aliceAgent = await createAgent(app, alice.cookie);
  const bob = await signUpHuman(app, "Bob");
  const bobAgent = await createAgent(app, bob.cookie);
  const s = store();
  // Alice creates the repo: insertRepo makes her its owner member.
  const repo = repoFixture({
    claim: { status: "claimed", ownerId: alice.principal.id, expiresAt: null },
  });
  await s.insertRepo(repo);
  const plan = planFixture(repo.id, aliceAgent.principal.id);
  await s.insertPlan(plan);
  const change = changeFixture(repo.id, aliceAgent.principal.id, { planId: plan.id });
  await s.insertChange(change);
  await s.putDiff(change.id, diffFixture());
  await s.putEvidence(await evidenceFixture(change.id));
  await s.putTour(tourFixture(change.id));
  await s.putClassification(change.id, change.headSha ?? "", classificationFixture());
  const run = runFixture(change.id);
  await s.upsertRun(run);
  const blob = `ci-logs/${run.id}/test.log`;
  await env.BLOBS.put(blob, "ok\n");
  await new DoAudit(env).append({
    principalId: alice.principal.id,
    action: "test.secret-event",
    subject: `change:${change.id}`,
    payload: {},
  });
  return { app, mock, s, alice, aliceAgent, bob, bobAgent, repo, plan, change, blob };
}

export type World = Awaited<ReturnType<typeof world>>;

/** Every read route of the repo, its plan and its change. */
export function readPaths(w: Pick<World, "repo" | "plan" | "change" | "blob">): string[] {
  const c = `/api/v1/changes/${w.change.id}`;
  return [
    `/api/v1/repos/${w.repo.id}`,
    `/api/v1/repos/${w.repo.id}/plans`,
    `/api/v1/repos/${w.repo.id}/changes`,
    `/api/v1/repos/${w.repo.id}/members`,
    `/api/v1/repos/${w.repo.id}/queue`,
    `/api/v1/plans/${w.plan.id}`,
    c,
    `${c}/diff`,
    `${c}/evidence`,
    `${c}/tour`,
    `${c}/reviews`,
    `${c}/rollout`,
    `${c}/issues`,
    `${c}/events`,
    `/api/v1/audit?subject=change:${w.change.id}`,
    `/api/v1/blobs/${encodeURIComponent(w.blob)}`,
  ];
}

export async function status(
  app: TestApp,
  path: string,
  auth: { cookie?: string; token?: string },
) {
  const res = await call(app, "GET", path, auth);
  const body = await res.text();
  return {
    path,
    status: res.status,
    code: res.status >= 400 ? JSON.parse(body).error?.code : null,
  };
}
