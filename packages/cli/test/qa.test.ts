import type { ToolArgs, ToolOutput } from "mcp-tada";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/errors.js";
import type { CliIntrospection } from "../src/mcp.js";
import { harness, run } from "./support/io.js";
import { mockConnector } from "./support/mcp.js";

type Brief = ToolOutput<CliIntrospection, "request_qa">["run"];

function brief(status: Brief["status"], failed = 0): Brief {
  return {
    id: "qa-chg_1-bbbbbbbbbb",
    changeId: "chg_1",
    headSha: "b".repeat(40),
    status,
    progress: status === "running" ? "criterion 1 of 2: pass" : null,
    summary: status === "done" ? { passed: 2 - failed, failed, couldntTest: 0 } : null,
    laneBefore: 1,
    laneAfter: failed > 0 ? 2 : 1,
    costUsd: 0.002,
    wallMs: 41_000,
    error: null,
    criteria:
      status === "done"
        ? [{ text: "Counter goes up", verdict: failed > 0 ? "fail" : "pass", reason: "r" }]
        : [],
    artifacts: [],
    reportUrl: "https://gittifacts.example/changes/chg_1#qa",
  };
}

function qaHarness(polls: Brief[]) {
  const asked: ToolArgs<CliIntrospection, "request_qa">[] = [];
  let i = 0;
  const h = harness({
    env: { GITTIFACTS_HOST: "https://gittifacts.example", GITTIFACTS_TOKEN: "t" },
  });
  h.io.connect = mockConnector({
    tools: {
      request_qa: async (args) => {
        asked.push(args);
        return {
          run: brief("queued"),
          reused: false,
          nextSteps: [{ title: "Read the result", call: 'get_qa({ changeId: "chg_1" })' }],
        };
      },
      get_qa: async () => ({
        runs: [polls[Math.min(i++, polls.length - 1)] as Brief],
        nextSteps: [],
      }),
    },
  });
  return { h, asked };
}

describe("gittifacts qa", () => {
  it("asks for QA and, with --wait, polls until the run finishes; a failed criterion exits 1", async () => {
    const { h, asked } = qaHarness([brief("running"), brief("done", 1)]);
    const r = await run(h, ["qa", "chg_1", "--wait"]);
    expect(asked).toEqual([{ changeId: "chg_1" }]);
    expect(r.code).toBe(1);
    expect(r.json()).toMatchObject({
      run: { status: "done", summary: { failed: 1 }, laneAfter: 2 },
    });
    h.cleanup();
  });

  it("all passed → exit 0; without --wait it returns the queued run at once with the next step", async () => {
    const passed = qaHarness([brief("done")]);
    expect((await run(passed.h, ["qa", "chg_1", "--wait"])).code).toBe(EXIT.ok);
    passed.h.cleanup();
    const quick = qaHarness([]);
    const r = await run(quick.h, ["qa", "--github", "acme/web#42", "--force"]);
    expect(quick.asked).toEqual([{ github: "acme/web#42", force: true }]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.json()).toMatchObject({
      run: { status: "queued" },
      nextSteps: [{ command: "gittifacts get-qa --change-id chg_1" }],
    });
    quick.h.cleanup();
  });

  it("needs exactly one of a change id or --github", async () => {
    const { h } = qaHarness([]);
    expect((await run(h, ["qa"])).code).toBe(EXIT.usage);
    h.cleanup();
  });
});
