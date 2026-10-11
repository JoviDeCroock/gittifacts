/**
 * Several agents attempt one approved Plan (workerd: real ChangeCoordinator + MergeQueue DOs,
 * ChangeWorkflow, BatchRunWorkflow). Three agents start Changes on the same planId at once with
 * deliberately different quality: a minimal correct one, one that also edits a file outside the
 * plan's scopePaths, one whose tests fail. compare_attempts ranks them; no agent (not even the
 * plan's author) can pick; a person picks the recommended one, which approves it and closes the
 * other two as superseded (their agents' wait_for_change says so); the pick is audited; the queue
 * lands the winner. Fake: Artifacts, containers, CI and the model (./fakes.ts).
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
import { createPlatformClient, type PlatformClient } from "@app/mcp/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { COORDINATOR_OPTIONS } from "../../src/coordinator.js";
import { buildPorts } from "../../src/runtime/ports.js";
import { call, createAgent, json, ORIGIN, signUpHuman, type TestApp } from "../http.js";
import {
  type IntegrationFakes,
  integrationOverrides,
  NAMESPACE,
  resetIntegrationFakes,
} from "./fakes.js";

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

const GREET = "export const greet = (name: string) => `hello ${name}`;\n";
const FIXED = "export const greet = (name: string) => `hi ${name}`;\n";
const TEST = 'import { greet } from "../src/greet";\n';

/** What each agent pushes: the same fix, done three ways. */
type Quality = "minimal" | "drift" | "red";
const pushes: Record<Quality, Record<string, string>> = {
  minimal: { "src/greet.ts": FIXED, "test/greet.test.ts": `${TEST}// hi\n` },
  drift: {
    "src/greet.ts": FIXED,
    "test/greet.test.ts": `${TEST}// hi\n`,
    "README.md": "# greet\n\nSays hi now. Also reworded the whole readme.\n",
  },
  red: { "src/greet.ts": FIXED, "test/greet.test.ts": `${TEST}// hi (breaks the old case)\n` },
};

interface Agent {
  quality: Quality;
  principalId: string;
  token: string;
  mcp: PlatformClient;
}

let fakes: IntegrationFakes;

beforeEach(() => {
  fakes = resetIntegrationFakes();
});

describe("attempts at one plan (workerd: real DOs + Workflows)", () => {
  it("three agents attempt one plan; compare_attempts ranks them; a person picks one; the others are superseded; the winner lands", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const created = await call(app, "POST", "/api/v1/repos", {
      cookie: human.cookie,
      body: { name: `attempts-${Date.now().toString(36)}` },
    });
    expect(created.status).toBe(201);
    const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
    const base = {
      "package.json": '{ "name": "greet", "scripts": { "test": "vitest run" } }\n',
      "README.md": "# greet\n",
      "src/greet.ts": GREET,
      "test/greet.test.ts": TEST,
    };
    const baseSha = fakes.git.seed(repo.artifactsName, base);

    const agents: Agent[] = [];
    for (const quality of ["minimal", "drift", "red"] as const) {
      const { token, principal } = await createAgent(app, human.cookie);
      const mcp = await createPlatformClient(`${ORIGIN}/mcp`, token, { fetch: fetchVia(app) });
      agents.push({ quality, principalId: principal.id, token, mcp });
    }
    const [minimal, drift, red] = agents as [Agent, Agent, Agent];

    // The minimal agent drafts the Plan; the person approves the intent before any code exists.
    const drafted = await call(app, "POST", "/api/v1/plans", {
      token: minimal.token,
      body: {
        repoId: repo.id,
        title: "Greet with hi",
        intent: "greet() must say hi instead of hello",
        acceptanceCriteria: ['greet("a") returns "hi a"'],
        scopePaths: ["src/greet.ts", "test/greet.test.ts"],
      },
    });
    expect(drafted.status).toBe(201);
    const { plan } = await json<{ plan: { id: string } }>(drafted);
    expect(
      (
        await call(app, "POST", `/api/v1/plans/${plan.id}/approve`, {
          cookie: human.cookie,
          body: {},
        })
      ).status,
    ).toBe(200);

    await using batchRuns = await introspectWorkflow(env.BATCH_RUN_WORKFLOW);
    await batchRuns.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const disposables: AsyncDisposable[] = [];
    try {
      // ------------------------------------------------ concurrently: start → push → graded
      const work = await Promise.all(
        agents.map(async (a) => {
          const started = await a.mcp.tools.start_change({
            repoId: repo.id,
            planId: plan.id,
            title: `Greet with hi (${a.quality})`,
            category: "fix",
            idempotencyKey: `attempt-${a.quality}`,
          });
          if (started.isError) throw new Error(JSON.stringify(started.content));
          const { change } = started.structuredContent;
          const head = fakes.git.commit(`task-${change.id}`, "main", pushes[a.quality]);
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
              source: {
                type: "artifacts.repo",
                namespace: NAMESPACE,
                repoName: `task-${change.id}`,
              },
              payload: { ref: "refs/heads/main", before: baseSha, after: head },
            },
          });
          await workflow.waitForStepResult({ name: "ci-start" });
          await fakes.ci.finish(
            env,
            ciRunIdFor(instanceId),
            a.quality === "red" ? { failTests: 2 } : {},
          );
          await workflow.waitForStepResult({
            name: a.quality === "red" ? "blocked" : "request-review",
          });
          return { agent: a, changeId: change.id, head, workflow };
        }),
      );
      const idOf = (q: Quality) => work.find((w) => w.agent.quality === q)!.changeId;
      const headOf = (q: Quality) => work.find((w) => w.agent.quality === q)!.head;

      // ------------------------------------------------ the ranking, as an agent reads it
      const compared = await red.mcp.tools.compare_attempts({ planId: plan.id });
      if (compared.isError) throw new Error(JSON.stringify(compared.content));
      const ranking = compared.structuredContent;
      expect(ranking.attempts.map((a) => a.changeId)).toEqual([
        idOf("minimal"),
        idOf("drift"),
        idOf("red"),
      ]);
      expect(ranking.recommended).toMatchObject({ changeId: idOf("minimal"), provisional: false });
      const [first, second, third] = ranking.attempts;
      expect(first).toMatchObject({ standing: "finished", green: true, pickable: true, lane: 1 });
      expect(first?.reasons).toEqual(
        expect.arrayContaining(["Lane 1", "red/green proven", "within plan scope"]),
      );
      expect(second).toMatchObject({ lane: 2, green: true, pickable: true });
      expect(second?.reasons).toContain("scope drift");
      expect(third).toMatchObject({
        standing: "finished",
        green: false,
        pickable: false,
        status: "failing",
      });
      expect(third?.reasons).toEqual(expect.arrayContaining(["CI failed", "2 tests failing"]));
      expect(ranking.picked).toBeNull();
      // The losing agents learn where they stand; the HTTP twin agrees with MCP.
      expect(ranking.nextSteps[0]?.title).toContain("ranks 3 of 3");
      const viaHttp = await call(app, "GET", `/api/v1/plans/${plan.id}/attempts`, {
        cookie: human.cookie,
      });
      expect(viaHttp.status).toBe(200);
      const httpRanking = await json<{ attempts: { changeId: string }[] }>(viaHttp);
      expect(httpRanking.attempts.map((a) => a.changeId)).toEqual(
        ranking.attempts.map((a) => a.changeId),
      );

      // ------------------------------------------------ no agent picks, not even the plan's author
      const pickPath = `/api/v1/plans/${plan.id}/attempts/${idOf("minimal")}/pick`;
      for (const a of [drift, minimal]) {
        const refused = await call(app, "POST", pickPath, { token: a.token, body: {} });
        expect(refused.status).toBe(403);
        const { error } = await json<{
          error: { code: string; fix: { call?: string; explanation: string } };
        }>(refused);
        expect(error.fix.call).toBe(`compare_attempts({ planId: "${plan.id}" })`);
        expect(error.fix.explanation).toContain(`/plans/${plan.id}`);
      }

      // The red attempt's merge wait answers at once: its head is failing, and only a new push
      // moves it (it never holds until the pick).
      const redWait = await red.mcp.tools.wait_for_change({
        changeId: idOf("red"),
        until: "merged",
        timeoutSec: 30,
      });
      if (redWait.isError) throw new Error(JSON.stringify(redWait.content));
      expect(redWait.structuredContent).toMatchObject({ reached: false, reason: "failing" });

      // The green loser's agent is waiting for its merge when the person picks.
      const waits = [drift].map((a) =>
        a.mcp.tools.wait_for_change({ changeId: idOf(a.quality), until: "merged", timeoutSec: 30 }),
      );

      // ------------------------------------------------ a person picks the recommended one
      const picked = await call(app, "POST", pickPath, {
        cookie: human.cookie,
        headers: { "idempotency-key": "pick-1" },
        body: { headSha: headOf("minimal") },
      });
      expect(picked.status).toBe(200);
      const pick = await json<{
        approved: boolean;
        change: { id: string; status: string };
        picked: { changeId: string; by: { id: string } };
        superseded: { changeId: string; status: string }[];
        notClosed: unknown[];
      }>(picked);
      expect(pick.approved).toBe(true);
      expect(pick.picked).toMatchObject({
        changeId: idOf("minimal"),
        by: { id: human.principal.id },
      });
      expect(pick.superseded.map((s) => s.changeId).sort()).toEqual(
        [idOf("drift"), idOf("red")].sort(),
      );
      expect(pick.superseded.every((s) => s.status === "abandoned")).toBe(true);
      expect(pick.notClosed).toEqual([]);

      // The losers' waits answer `superseded`, naming the winner (the red one's, asked again, too).
      const redAgain = red.mcp.tools.wait_for_change({
        changeId: idOf("red"),
        until: "merged",
        timeoutSec: 30,
      });
      for (const w of await Promise.all([...waits, redAgain])) {
        if (w.isError) throw new Error(JSON.stringify(w.content));
        expect(w.structuredContent).toMatchObject({
          reached: false,
          reason: "superseded",
          supersededBy: idOf("minimal"),
        });
        expect(w.structuredContent.nextSteps[0]?.call).toBe(
          `compare_attempts({ planId: "${plan.id}" })`,
        );
      }
      // get_change_status says the same, so an agent that wasn't waiting learns it too.
      const status = await drift.mcp.tools.get_change_status({ changeId: idOf("drift") });
      if (status.isError) throw new Error(JSON.stringify(status.content));
      expect(status.structuredContent).toMatchObject({
        supersededBy: idOf("minimal"),
        change: { status: "abandoned" },
      });
      expect(status.structuredContent.nextSteps[0]?.title).toContain("picked another attempt");
      // A second pick of another attempt is refused.
      const again = await call(
        app,
        "POST",
        `/api/v1/plans/${plan.id}/attempts/${idOf("drift")}/pick`,
        {
          cookie: human.cookie,
          body: {},
        },
      );
      expect(again.status).toBe(409);
      expect((await json<{ error: { code: string } }>(again)).error.code).toBe("already-picked");

      // The approval is the normal review record, by the person, bound to the picked head.
      const reviews = await json<{
        reviews: { decision: string; reviewerId: string; headSha: string }[];
      }>(
        await call(app, "GET", `/api/v1/changes/${idOf("minimal")}/reviews`, {
          cookie: human.cookie,
        }),
      );
      expect(reviews.reviews).toContainEqual(
        expect.objectContaining({
          decision: "approve",
          reviewerId: human.principal.id,
          headSha: headOf("minimal"),
        }),
      );

      // ------------------------------------------------ audited
      const audit = async (subject: string) =>
        (
          await json<{ events: { action: string; principalId: string }[] }>(
            await call(app, "GET", `/api/v1/audit?subject=${subject}`, { cookie: human.cookie }),
          )
        ).events;
      expect(await audit(`plan:${plan.id}`)).toContainEqual(
        expect.objectContaining({ action: "plan.attempt-picked", principalId: human.principal.id }),
      );
      for (const q of ["drift", "red"] as const) {
        const actions = (await audit(`change:${idOf(q)}`)).map((e) => e.action);
        expect(actions).toEqual(expect.arrayContaining(["change.superseded", "change.abandoned"]));
      }

      // ------------------------------------------------ the queue lands the winner
      const mainFile = (path: string) => {
        const head = fakes.git.head(repo.artifactsName);
        return head === null ? undefined : fakes.git.filesAt(head)[path];
      };
      await vi.waitFor(
        async () => {
          for (const [id, run] of [...fakes.ci.runs])
            if (id.startsWith("mq-") && run.status.status === "running")
              await fakes.ci.finish(env, id);
          expect(mainFile("src/greet.ts")).toBe(FIXED);
        },
        { timeout: 30_000, interval: 100 },
      );
      expect(mainFile("README.md")).toBe("# greet\n"); // the drifting attempt never landed
      const merged = await minimal.mcp.tools.wait_for_merge({
        changeId: idOf("minimal"),
        timeoutSec: 30,
      });
      if (merged.isError) throw new Error(JSON.stringify(merged.content));
      expect(merged.structuredContent).toMatchObject({ reason: "merged" });

      // Afterwards the ranking says who picked what; the winner's agent is told it landed.
      const after = await minimal.mcp.tools.compare_attempts({ planId: plan.id });
      if (after.isError) throw new Error(JSON.stringify(after.content));
      expect(after.structuredContent.picked).toMatchObject({ changeId: idOf("minimal") });
      expect(
        after.structuredContent.attempts
          .filter((a) => a.standing === "closed")
          .map((a) => a.changeId)
          .sort(),
      ).toEqual([idOf("drift"), idOf("red")].sort());
      await work.find((w) => w.agent.quality === "minimal")!.workflow.waitForStatus("complete");
    } finally {
      for (const d of disposables) await d[Symbol.asyncDispose]();
      await Promise.all(agents.map((a) => a.mcp.client.close()));
    }
  });
});
