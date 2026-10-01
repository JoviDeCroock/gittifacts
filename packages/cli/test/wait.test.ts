import type { ToolArgs, ToolOutput } from "mcp-tada";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/errors.js";
import type { CliIntrospection } from "../src/mcp.js";
import { harness, run } from "./support/io.js";
import { mockConnector } from "./support/mcp.js";

type WaitOut = ToolOutput<CliIntrospection, "wait_for_change">;
type WaitArgs = ToolArgs<CliIntrospection, "wait_for_change">;

function waitResult(status: WaitOut["change"]["status"], reason: WaitOut["reason"]): WaitOut {
  return {
    reached: reason === "reached",
    reason,
    change: {
      id: "chg_1",
      repoId: "repo_1",
      planId: "plan_1",
      title: "Rate limit logins",
      category: "feature",
      status,
      lane: 1,
      computedLane: 1,
      laneReasons: [],
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      forkName: "task-chg_1",
      mergedSha: null,
      revertOf: null,
      updatedAt: "2026-10-01T00:00:00Z",
    },
    nextSteps: [
      {
        title: "Watch for production issues",
        call: 'list_issues_for_change({ changeId: "chg_1" })',
      },
    ],
  };
}

/** A harness whose wait_for_change answers from `script`, taking `timeoutSec` of fake time. */
function waitHarness(script: (WaitOut | Error)[], opts: { block?: boolean } = {}) {
  const calls: WaitArgs[] = [];
  let i = 0;
  const h = harness({
    env: { GITTIFACTS_HOST: "https://gittifacts.example", GITTIFACTS_TOKEN: "t" },
  });
  h.io.connect = mockConnector({
    tools: {
      wait_for_change: async (args, options) => {
        calls.push(args);
        if (opts.block) {
          setTimeout(() => h.interrupt(), 5);
          return new Promise<WaitOut>((_, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
          });
        }
        const next = script[Math.min(i++, script.length - 1)];
        if (next instanceof Error) throw next;
        if (!next) throw new Error("script exhausted");
        if (next.reason === "timeout") h.clock.now += (args.timeoutSec ?? 120) * 1000;
        return next;
      },
    },
  });
  return { h, calls };
}

describe("gittifacts wait", () => {
  it("re-issues the long-poll until the milestone is reached", async () => {
    const { h, calls } = waitHarness([
      waitResult("running", "timeout"),
      waitResult("queued", "timeout"),
      waitResult("merged", "reached"),
    ]);
    const r = await run(h, ["wait", "chg_1", "--until", "merged"]);
    expect(r.code).toBe(EXIT.ok);
    expect(calls).toEqual([
      { changeId: "chg_1", until: "merged", timeoutSec: 90 },
      { changeId: "chg_1", until: "merged", timeoutSec: 90 },
      { changeId: "chg_1", until: "merged", timeoutSec: 90 },
    ]);
    const doc = r.json() as {
      reached: boolean;
      waited: { attempts: number };
      nextSteps: { command?: string }[];
    };
    expect(doc.reached).toBe(true);
    expect(doc.waited.attempts).toBe(3);
    expect(doc.nextSteps[0]?.command).toBe("gittifacts list-issues-for-change --change-id chg_1");
    h.cleanup();
  });

  it("stops at --timeout, shrinking the last window, and exits 3", async () => {
    const { h, calls } = waitHarness([waitResult("running", "timeout")]);
    const r = await run(h, ["wait", "chg_1", "--until", "evidence_ready", "--timeout", "100"]);
    expect(r.code).toBe(EXIT.notReached);
    expect(calls.map((c) => c.timeoutSec)).toEqual([90, 10]);
    expect(r.json()).toMatchObject({
      reached: false,
      reason: "timeout",
      waited: { attempts: 2, seconds: 100, timeoutSec: 100 },
    });
    h.cleanup();
  });

  it("returns at once when the milestone can't be reached", async () => {
    const { h, calls } = waitHarness([waitResult("abandoned", "unreachable")]);
    const r = await run(h, ["wait", "chg_1", "--until", "merged", "--human"]);
    expect(r.code).toBe(EXIT.notReached);
    expect(calls).toHaveLength(1);
    expect(r.stdout).toMatch(/^chg_1: merged not reached/);
    expect(r.stdout).toMatch(/Reason: +unreachable/);
    h.cleanup();
  });

  it("retries a dropped connection, then carries on", async () => {
    const { h, calls } = waitHarness([
      new TypeError("fetch failed"),
      waitResult("merged", "reached"),
    ]);
    const r = await run(h, ["wait", "chg_1", "--until", "merged"]);
    expect(r.code).toBe(EXIT.ok);
    expect(calls).toHaveLength(2);
    expect(h.sleeps).toContain(2000);
    h.cleanup();
  });

  it("stops cleanly on Ctrl-C (exit 130, with the command to resume)", async () => {
    const { h } = waitHarness([], { block: true });
    const r = await run(h, ["wait", "chg_1", "--until", "tour_ready", "--timeout", "300"]);
    expect(r.code).toBe(EXIT.interrupted);
    expect(r.json()).toEqual({
      error: {
        code: "interrupted",
        message: "stopped waiting for chg_1",
        fix: {
          explanation: expect.any(String),
          command: "gittifacts wait chg_1 --until tour_ready --timeout 300",
        },
      },
    });
    h.cleanup();
  });

  it("validates --until against the tool's schema before connecting", async () => {
    const { h, calls } = waitHarness([]);
    const r = await run(h, ["wait", "chg_1", "--until", "deployed"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.json()).toMatchObject({
      error: { code: "usage", message: expect.stringContaining("evidence_ready") },
    });
    expect(calls).toHaveLength(0);
    const missing = await run(h, ["wait", "--until", "merged"]);
    expect(missing.code).toBe(EXIT.usage);
    h.cleanup();
  });

  it("passes a platform error through with its fix", async () => {
    const h = harness({ env: { GITTIFACTS_HOST: "https://gittifacts.example" } });
    h.io.connect = mockConnector({
      tools: {
        wait_for_change: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  code: "not-found",
                  message: "change nope not found",
                  fix: { explanation: "List what exists.", call: "list_repos({})" },
                },
              }),
            },
          ],
        },
      },
    });
    const r = await run(h, ["wait", "nope", "--until", "merged"]);
    expect(r.code).toBe(EXIT.error);
    expect(r.json()).toEqual({
      error: {
        code: "not-found",
        message: "change nope not found",
        fix: {
          explanation: "List what exists.",
          call: "list_repos({})",
          command: "gittifacts list-repos",
        },
      },
    });
    h.cleanup();
  });

  it("the wait-for-change mirror gives the long-poll more than the SDK's 60s default", async () => {
    const seen: (number | undefined)[] = [];
    const h = harness({ env: { GITTIFACTS_HOST: "https://gittifacts.example" } });
    h.io.connect = mockConnector({
      tools: {
        wait_for_change: (_args, options) => {
          seen.push(options?.timeout);
          return waitResult("merged", "reached");
        },
      },
    });
    expect(
      (await run(h, ["wait-for-change", "chg_1", "--until", "merged", "--timeout-sec", "600"]))
        .code,
    ).toBe(0);
    expect((await run(h, ["wait-for-change", "chg_1", "--until", "merged"])).code).toBe(0);
    expect(seen).toEqual([630_000, 180_000]);
    h.cleanup();
  });
});
