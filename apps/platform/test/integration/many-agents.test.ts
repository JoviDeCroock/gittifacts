/**
 * Many agents, one repo, at the same time (workerd: real ChangeCoordinator + MergeQueue DOs,
 * ChangeWorkflow, BatchRunWorkflow). Cloudflare's "next Git platform" brief (DECISIONS 2026-10-10)
 * asks at a minimum for multiple agents working on changes concurrently: four agent principals
 * start, push and enqueue Changes on one repo concurrently; each is graded by its own ChangeWorkflow;
 * no agent can approve (its own Change or another's); a human approves; the queue lands every Change
 * on main with CAS, each still attributed to the agent that wrote it, and every agent sees its own
 * merge through wait_for_merge. Each landed commit carries a signed `refs/notes/why` note (why it
 * exists, who answers for it): agent 1 works from a human-approved Plan, so its note carries that
 * intent and approver. Fake: Artifacts, containers, CI and the model (./fakes.ts).
 */
import {
  createExecutionContext,
  introspectWorkflow,
  introspectWorkflowInstance,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  changeWorkflowId,
  ciRunIdFor,
  cloudflareBindings,
  createCoordinator,
} from "@app/coordinator";
import { decodeWhyNote, parseKeySet, verifyWhyNote, WHY_NOTES_REF } from "@app/evidence";
import { createPlatformClient, type PlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { COORDINATOR_OPTIONS } from "../../src/coordinator.js";
import { buildPorts } from "../../src/runtime/ports.js";
import { Purpose } from "../../src/signing.js";
import { call, createAgent, json, ORIGIN, signUpHuman, type TestApp } from "../http.js";
import {
  type IntegrationFakes,
  integrationOverrides,
  NAMESPACE,
  resetIntegrationFakes,
} from "./fakes.js";

const AGENTS = 4;

function fetchVia(app: TestApp) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(input, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

function platformApp(): TestApp {
  return createApp({
    coordinator: (e) =>
      createCoordinator(
        buildPorts(e, "default", { overrides: integrationOverrides("default") }),
        cloudflareBindings(e),
        COORDINATOR_OPTIONS,
      ),
  });
}

/** Agent i's module before and after its fix (each agent owns a disjoint pair of files). */
const moduleOf = (i: number, add: number) => `export const m${i} = (x: number) => x + ${add};\n`;
const testOf = (i: number, extra = "") => `import { m${i} } from "../src/m${i}";\n${extra}`;

let fakes: IntegrationFakes;

beforeEach(() => {
  fakes = resetIntegrationFakes();
});

interface Agent {
  i: number;
  principalId: string;
  token: string;
  mcp: PlatformClient;
}

describe("many agents, one repo (workerd: real DOs + Workflows)", () => {
  it("four agents start, push and enqueue at once; none can approve; a human approves; the queue lands all four", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const created = await call(app, "POST", "/api/v1/repos", {
      cookie: human.cookie,
      body: { name: `agents-${Date.now().toString(36)}` },
    });
    expect(created.status).toBe(201);
    const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
    const base: Record<string, string> = {
      "package.json": '{ "name": "agents", "scripts": { "test": "vitest run" } }\n',
    };
    for (let i = 1; i <= AGENTS; i++) {
      base[`src/m${i}.ts`] = moduleOf(i, i);
      base[`test/m${i}.test.ts`] = testOf(i);
    }
    const baseSha = fakes.git.seed(repo.artifactsName, base);

    // Four distinct agent principals, owned by one human, each with its own token and MCP session.
    const agents: Agent[] = [];
    for (let i = 1; i <= AGENTS; i++) {
      const { token, principal } = await createAgent(app, human.cookie);
      const mcp = await createPlatformClient(`${ORIGIN}/mcp`, token, { fetch: fetchVia(app) });
      agents.push({ i, principalId: principal.id, token, mcp });
    }
    expect(new Set(agents.map((a) => a.principalId)).size).toBe(AGENTS);

    // Agent 1 drafts a Plan; the human approves the intent before any code exists.
    const drafted = await call(app, "POST", "/api/v1/plans", {
      token: agents[0]!.token,
      body: {
        repoId: repo.id,
        title: "Scale m1 by ten",
        intent: "m1 must add ten times its index, not its index",
        acceptanceCriteria: ["m1(0) returns 10"],
        outOfScope: ["m2, m3 and m4"],
        scopePaths: ["src/m1.ts", "test/m1.test.ts"],
      },
    });
    expect(drafted.status).toBe(201);
    const { plan } = await json<{ plan: { id: string } }>(drafted);
    const approvedPlan = await call(app, "POST", `/api/v1/plans/${plan.id}/approve`, {
      cookie: human.cookie,
      body: {},
    });
    expect(approvedPlan.status).toBe(200);

    await using batchRuns = await introspectWorkflow(env.BATCH_RUN_WORKFLOW);
    await batchRuns.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const disposables: AsyncDisposable[] = [];
    try {
      // ------------------------------------------------ concurrently: start → push → graded → enqueue
      const work = await Promise.all(
        agents.map(async (a) => {
          const started = await a.mcp.tools.start_change({
            repoId: repo.id,
            title: `Fix m${a.i}()`,
            category: "fix",
            ...(a.i === 1 ? { planId: plan.id } : {}),
            idempotencyKey: `agents-${a.i}`,
          });
          if (started.isError) throw new Error(JSON.stringify(started.content));
          const { change } = started.structuredContent;
          const forkName = `task-${change.id}`;
          const head = fakes.git.commit(forkName, "main", {
            [`src/m${a.i}.ts`]: moduleOf(a.i, a.i * 10),
            [`test/m${a.i}.test.ts`]: testOf(a.i, "// regression test\n"),
          });
          const instanceId = changeWorkflowId(change.id, head);
          const workflow = await introspectWorkflowInstance(env.CHANGE_WORKFLOW, instanceId);
          disposables.push(workflow);
          await workflow.modify(async (m) => {
            await m.disableSleeps();
            await m.disableRetryDelays();
          });
          await env.PUSH_ROUTER.create({
            id: `push-${head}`,
            params: {
              type: "cf.artifacts.repo.pushed",
              source: { type: "artifacts.repo", namespace: NAMESPACE, repoName: forkName },
              payload: { ref: "refs/heads/main", before: baseSha, after: head },
            },
          });
          await workflow.waitForStepResult({ name: "ci-start" });
          await fakes.ci.finish(env, ciRunIdFor(instanceId));
          await workflow.waitForStepResult({ name: "request-review" });
          const queued = await a.mcp.tools.enqueue({ changeId: change.id });
          if (queued.isError) throw new Error(JSON.stringify(queued.content));
          expect(queued.structuredContent).toMatchObject({
            admitted: false,
            state: "pending-admission",
          });
          return { agent: a, changeId: change.id, head, workflow };
        }),
      );
      // Four Changes, four forks, four ChangeWorkflows, all graded and waiting for a human.
      expect(new Set(work.map((w) => w.changeId)).size).toBe(AGENTS);

      // ------------------------------------------------ no agent approves: not its own, not another's
      for (const w of work) {
        const self = await call(app, "POST", `/api/v1/changes/${w.changeId}/review`, {
          token: w.agent.token,
          body: { decision: "approve" },
        });
        expect(self.status).toBe(403);
        const peer = work[(work.indexOf(w) + 1) % AGENTS]!;
        const other = await call(app, "POST", `/api/v1/changes/${w.changeId}/review`, {
          token: peer.agent.token,
          body: { decision: "approve" },
        });
        expect(other.status).toBe(403);
        // Agents can't move each other's queue entries either.
        const foreign = await call(app, "POST", `/api/v1/changes/${w.changeId}/queue`, {
          token: peer.agent.token,
          body: {},
        });
        expect(foreign.status).toBe(403);
      }

      // ------------------------------------------------ a human approves all four at once
      const reviews = await Promise.all(
        work.map((w) =>
          call(app, "POST", `/api/v1/changes/${w.changeId}/review`, {
            cookie: human.cookie,
            body: { decision: "approve" },
          }),
        ),
      );
      expect(reviews.map((r) => r.status)).toEqual(work.map(() => 200));

      // ------------------------------------------------ the queue tests and lands every Change
      // Pass every queue run (refs/queue/<batch> on main) as it appears until all four landed.
      const mainFile = (path: string) => {
        const head = fakes.git.head(repo.artifactsName);
        return head === null ? undefined : fakes.git.filesAt(head)[path];
      };
      await vi.waitFor(
        async () => {
          for (const [id, run] of [...fakes.ci.runs])
            if (id.startsWith("mq-") && run.status.status === "running")
              await fakes.ci.finish(env, id);
          for (const w of work)
            expect(mainFile(`src/m${w.agent.i}.ts`)).toBe(moduleOf(w.agent.i, w.agent.i * 10));
        },
        { timeout: 30_000, interval: 100 },
      );
      expect(Object.keys(fakes.git.filesAt(fakes.git.head(repo.artifactsName)!)).sort()).toEqual(
        Object.keys(base).sort(),
      );

      // Each agent sees its own merge, and each Change is still attributed to its author.
      const merges = await Promise.all(
        work.map((w) => w.agent.mcp.tools.wait_for_merge({ changeId: w.changeId, timeoutSec: 30 })),
      );
      for (const m of merges) {
        if (m.isError) throw new Error(JSON.stringify(m.content));
        expect(m.structuredContent).toMatchObject({ reason: "merged" });
      }
      for (const w of work) {
        const res = await call(app, "GET", `/api/v1/changes/${w.changeId}`, {
          cookie: human.cookie,
        });
        const { change } = await json<{ change: { authorId: string; status: string } }>(res);
        expect(change.authorId).toBe(w.agent.principalId);
        // Past the merge: rolling out behind its flag, or already released.
        expect(["merged", "rolling-out", "released"]).toContain(change.status);
      }
      const overview = await call(app, "GET", `/api/v1/repos/${repo.id}/queue`, {
        token: agents[0]!.token,
      });
      const o = await json<{ entries: { changeId: string; state: string }[] }>(overview);
      for (const w of work)
        expect(o.entries).toContainEqual(
          expect.objectContaining({ changeId: w.changeId, state: "merged" }),
        );
      // refs/queue/* are garbage-collected once every batch landed.
      await vi.waitFor(() => {
        const refs = [...fakes.git.repo(repo.artifactsName).refs.keys()].filter((r) =>
          r.startsWith("refs/queue/"),
        );
        expect(refs).toEqual([]);
      });
      await Promise.all(work.map((w) => w.workflow.waitForStatus("complete")));

      // ------------------------------------------------ why each commit exists, from git alone
      const main = fakes.git.head(repo.artifactsName)!;
      const onMain = new Set(fakes.git.ancestry(main));
      const notes = [...(fakes.git.repo(repo.artifactsName).notes.get(WHY_NOTES_REF) ?? new Map())];
      const whyOf = new Map(
        notes.map(([sha, text]) => [decodeWhyNote(text).changeId, { sha, text }]),
      );
      // Verified as any clone would: the published keys and verify-attestation's own check.
      const keysRes = await call(app, "GET", "/.well-known/gittifacts-keys.json");
      expect(keysRes.status).toBe(200);
      const keys = parseKeySet(await keysRes.json());
      for (const w of work) {
        const found = whyOf.get(w.changeId);
        expect(found, `no why note for agent ${w.agent.i}'s Change`).toBeDefined();
        const why = decodeWhyNote(found!.text);
        expect(onMain.has(found!.sha)).toBe(true);
        expect(why).toMatchObject({
          landedSha: found!.sha,
          headSha: w.head,
          author: { id: w.agent.principalId, kind: "agent" },
          accountable: { id: human.principal.id, kind: "human" },
          approvals: [
            expect.objectContaining({
              reviewer: expect.objectContaining({ id: human.principal.id }),
            }),
          ],
          plan:
            w.agent.i === 1
              ? {
                  id: plan.id,
                  intent: "m1 must add ten times its index, not its index",
                  approvedBy: expect.objectContaining({ id: human.principal.id, kind: "human" }),
                }
              : null,
        });
        expect(why.evidenceId).not.toBeNull();
        expect(why.attestation.purpose).toBe(Purpose.document);
        expect(await verifyWhyNote(found!.text, keys, { commit: found!.sha })).toMatchObject({
          ok: true,
          bindingChecked: true,
        });
      }
    } finally {
      for (const d of disposables) await d[Symbol.asyncDispose]();
      await Promise.all(agents.map((a) => a.mcp.client.close()));
    }
  });

  // The live demo (scripts/e2e/many-agents.ts) on a static site: docs-only Changes have no test
  // targets, so once the first lands the others revalidate on main with an EMPTY target set (live
  // 2026-10-11: the engine refused `testTargets: []`, the BatchRunWorkflow errored without a
  // result, and four landing batches sat "running" for 25+ min). Agents 1 and 2 retitle the same
  // README line; the resolver's merge writes a line found on neither side, so the human must
  // approve the resolution again (live: the demo only approved first reviews and hung there).
  it("docs-only Changes revalidate on main with no test targets and land; the README resolution waits for the human's re-approval", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const created = await call(app, "POST", "/api/v1/repos", {
      cookie: human.cookie,
      body: { name: `docs-${Date.now().toString(36)}` },
    });
    const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
    const intro = "\nA static site served by Workers static assets.\n";
    const baseSha = fakes.git.seed(repo.artifactsName, {
      "README.md": `# demo${intro}`,
      "public/index.html": "<h1>demo</h1>\n",
    });
    const titled = (...tags: string[]) => `# demo${tags.map((t) => ` (${t})`).join("")}${intro}`;
    // The resolver keeps both titles on one line: a line neither side wrote (needs re-approval).
    fakes.resolver.script = {
      novelLines: 1,
      resolve: ({ files }) => {
        const tag = (text: string | null) => /\((agent-\d)\)/.exec(text ?? "")?.[1] ?? "?";
        const readme = files.find((f) => f.path === "README.md");
        return readme === undefined
          ? null
          : { "README.md": titled(tag(readme.theirs), tag(readme.ours)) };
      },
    };
    const agents: Agent[] = [];
    for (let i = 1; i <= AGENTS; i++) {
      const { token, principal } = await createAgent(app, human.cookie);
      const mcp = await createPlatformClient(`${ORIGIN}/mcp`, token, { fetch: fetchVia(app) });
      agents.push({ i, principalId: principal.id, token, mcp });
    }
    await using batchRuns = await introspectWorkflow(env.BATCH_RUN_WORKFLOW);
    await batchRuns.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const disposables: AsyncDisposable[] = [];
    try {
      const work = await Promise.all(
        agents.map(async (a) => {
          const path = a.i <= 2 ? "README.md" : `AGENT-${a.i}.md`;
          const started = await a.mcp.tools.start_change({
            repoId: repo.id,
            title: `Many agents agent-${a.i}`,
            category: "docs",
            paths: [path],
            idempotencyKey: `docs-${a.i}`,
          });
          if (started.isError) throw new Error(JSON.stringify(started.content));
          const { change } = started.structuredContent;
          const forkName = `task-${change.id}`;
          const head = fakes.git.commit(forkName, "main", {
            [path]: a.i <= 2 ? titled(`agent-${a.i}`) : `# agent-${a.i}\n\nIndependent work.\n`,
          });
          const instanceId = changeWorkflowId(change.id, head);
          const workflow = await introspectWorkflowInstance(env.CHANGE_WORKFLOW, instanceId);
          disposables.push(workflow);
          await workflow.modify(async (m) => {
            await m.disableSleeps();
            await m.disableRetryDelays();
          });
          await env.PUSH_ROUTER.create({
            id: `push-${head}`,
            params: {
              type: "cf.artifacts.repo.pushed",
              source: { type: "artifacts.repo", namespace: NAMESPACE, repoName: forkName },
              payload: { ref: "refs/heads/main", before: baseSha, after: head },
            },
          });
          await workflow.waitForStepResult({ name: "ci-start" });
          await fakes.ci.finish(env, ciRunIdFor(instanceId));
          await workflow.waitForStepResult({ name: "request-review" });
          const queued = await a.mcp.tools.enqueue({ changeId: change.id });
          if (queued.isError) throw new Error(JSON.stringify(queued.content));
          return { agent: a, changeId: change.id };
        }),
      );
      for (const w of work) {
        const r = await call(app, "POST", `/api/v1/changes/${w.changeId}/review`, {
          cookie: human.cookie,
          body: { decision: "approve" },
        });
        expect(r.status).toBe(200);
      }
      // Like the demo's human: pass each queue run, and approve a resolution that asks for it
      // (the Change is back in awaiting-review and its resolution says approvalRequested).
      const reapproved = new Map<string, string>();
      const states = async () => {
        const res = await call(app, "GET", `/api/v1/repos/${repo.id}/queue`, {
          cookie: human.cookie,
        });
        return json<{
          entries: { changeId: string; state: string }[];
          landing: { id: string; targets: string[] | "all" }[];
          stalls: unknown[];
        }>(res);
      };
      const landingTargets = new Map<string, string[] | "all">();
      await vi.waitFor(
        async () => {
          for (const [id, run] of [...fakes.ci.runs])
            if (id.startsWith("mq-") && run.status.status === "running")
              await fakes.ci.finish(env, id);
          for (const w of work) {
            const res = await call(app, "GET", `/api/v1/changes/${w.changeId}/resolution`, {
              cookie: human.cookie,
            });
            const { resolution } = await json<{
              resolution: { headSha: string; approvalRequested: boolean } | null;
            }>(res);
            if (resolution?.approvalRequested !== true || reapproved.has(w.changeId)) continue;
            const c = await call(app, "GET", `/api/v1/changes/${w.changeId}`, {
              cookie: human.cookie,
            });
            const { change } = await json<{ change: { status: string } }>(c);
            if (change.status !== "awaiting-review") continue;
            const r = await call(app, "POST", `/api/v1/changes/${w.changeId}/review`, {
              cookie: human.cookie,
              body: { decision: "approve" },
            });
            expect(r.status).toBe(200);
            reapproved.set(w.changeId, resolution.headSha);
          }
          const o = await states();
          for (const l of o.landing) landingTargets.set(l.id, l.targets);
          for (const w of work)
            expect(o.entries).toContainEqual(
              expect.objectContaining({ changeId: w.changeId, state: "merged" }),
            );
        },
        { timeout: 45_000, interval: 100 },
      );
      // Both README titles landed (through the resolution), and both agents' notes.
      const files = fakes.git.filesAt(fakes.git.head(repo.artifactsName)!);
      expect([titled("agent-2", "agent-1"), titled("agent-1", "agent-2")]).toContain(
        files["README.md"],
      );
      expect(Object.keys(files)).toEqual(expect.arrayContaining(["AGENT-3.md", "AGENT-4.md"]));
      // Exactly one README Change was resolved, and it needed (and got) the human's re-approval.
      expect(reapproved.size).toBe(1);
      const [resolvedId] = [...reapproved.keys()];
      expect(work.filter((w) => w.agent.i <= 2).map((w) => w.changeId)).toContain(resolvedId);
      expect(fakes.resolver.calls).toContain(resolvedId);
      // Docs-only Changes revalidated on main with no impacted test target, and still landed:
      // the run on the landing tree covers everything (the engine takes no empty target list).
      expect([...landingTargets.values()]).toContainEqual([]);
      const landingRuns = [...fakes.ci.runs].filter(([id]) => /-l[0-9a-z]+-r\d+-r$/.test(id));
      expect(landingRuns.length).toBeGreaterThan(0);
      for (const [, run] of landingRuns) expect(run.request.testTargets).toBeUndefined();
      expect((await states()).stalls).toEqual([]);
    } finally {
      for (const d of disposables) await d[Symbol.asyncDispose]();
      await Promise.all(agents.map((a) => a.mcp.client.close()));
    }
  }, 60_000);
});
