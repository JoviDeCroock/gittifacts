import { describe, expect, it } from "vitest";
import { DEFAULT_GATES, evaluateGates } from "../../src/gates.js";
import { aggregate, median, percentile } from "../../src/metrics.js";
import { renderReport } from "../../src/report.js";
import type { MatrixView, RunResult } from "../../src/results.js";
import { TASK_IDS, type TaskId } from "../../src/tasks.js";

const NOW = Date.parse("2026-10-03T06:00:00Z");
const MODELS = [
  { short: "kimi", provider: "moonshot", id: "@cf/moonshotai/kimi-k2.7-code" },
  { short: "gptoss", provider: "openai", id: "@cf/openai/gpt-oss-120b" },
];

function run(
  task: TaskId,
  m: (typeof MODELS)[number],
  i: number,
  over: Partial<RunResult> = {},
): RunResult {
  return {
    v: 1,
    runId: `m1--${task}--${m.short}--r${i}`,
    matrixId: "m1",
    task,
    model: m.id,
    modelShort: m.short,
    provider: m.provider,
    attempt: i,
    stop: "final",
    note: null,
    success: true,
    checks: [{ name: "project-created", pass: true, detail: "ok" }],
    startedAt: "2026-10-03T03:00:00Z",
    endedAt: "2026-10-03T03:05:00Z",
    wallMs: 300_000,
    turns: 10,
    toolCalls: 12,
    toolCounts: { http_fetch: 4, mcp_call: 8 },
    errors: { tool: 1, codes: ["rate-limited"] },
    ttfgMs: 40_000,
    ttfgSource: "probe",
    tokens: { prompt: 100_000, completion: 5000, cached: 0 },
    neurons: 10_000,
    costUsd: 0.11,
    safety: { violations: [], subjects: 4 },
    ids: { repoIds: ["r1"], changeIds: [], planIds: [], previewUrls: [] },
    finalMessage: "done",
    ...over,
  };
}

function matrix(runs: RunResult[], over: Partial<MatrixView> = {}): MatrixView {
  return {
    matrix: {
      v: 1,
      matrixId: "m1",
      trigger: "cron",
      platform: "https://platform.test",
      createdAt: "2026-10-03T03:00:00Z",
      tasks: [...TASK_IDS],
      models: MODELS.map((m) => m.id),
      runsPerCell: 5,
      concurrency: 4,
      runs: runs.map((r) => ({ runId: r.runId, task: r.task, model: r.model, attempt: r.attempt })),
    },
    runs,
    sweep: { from: "a", to: "b", complete: true, events: 100, violations: [], error: null },
    complete: true,
    ...over,
  };
}

function full(mutate: (r: RunResult) => RunResult = (r) => r): RunResult[] {
  return TASK_IDS.flatMap((t) =>
    MODELS.flatMap((m) => [1, 2, 3, 4, 5].map((i) => mutate(run(t, m, i)))),
  );
}

const opts = { ...DEFAULT_GATES, nowMs: NOW };

describe("metrics", () => {
  it("median, nearest-rank p90, infinity as null", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([1, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY])).toBeNull();
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90)).toBe(90);
    expect(median([])).toBeNull();
  });

  it("aggregates per cell and per task; failures count as ∞ TTFG; skipped runs are not counted", () => {
    const runs = [
      run("t1", MODELS[0]!, 1, { ttfgMs: 30_000 }),
      run("t1", MODELS[0]!, 2, { ttfgMs: 50_000 }),
      run("t1", MODELS[0]!, 3, {
        success: false,
        ttfgMs: null,
        errors: { tool: 2, codes: ["x", "rate-limited"] },
      }),
      run("t2", MODELS[0]!, 1, { stop: "skipped", success: false }),
    ];
    const a = aggregate(runs, TASK_IDS);
    const t1 = a.cells.find((c) => c.task === "t1")!;
    expect(t1).toMatchObject({
      runs: 3,
      successes: 2,
      ttfgMedianMs: 50_000,
      ttfgP90Ms: null,
      toolErrors: 4,
    });
    expect(t1.topCodes).toEqual([
      ["rate-limited", 3],
      ["x", 1],
    ]);
    expect(a.cells.find((c) => c.task === "t2")).toMatchObject({
      runs: 0,
      skipped: 1,
      successRate: null,
    });
  });
});

describe("gates", () => {
  it("pass on a complete, fresh, green matrix", () => {
    const g = evaluateGates(matrix(full()), opts);
    expect(g.gates.filter((x) => !x.pass)).toEqual([]);
    expect(g.pass).toBe(true);
    expect(g.gates.map((x) => x.name)).toEqual([
      "complete",
      "fresh",
      "coverage",
      "success:t1",
      "success:t2",
      "success:t3",
      "success:t4",
      "ttfg:t1",
      "safety",
    ]);
  });

  it("fail below 90% success on a task (9/10 passes, 8/10 fails)", () => {
    let n = 0;
    const nine = full((r) => (r.task === "t3" && n++ < 1 ? { ...r, success: false } : r));
    expect(evaluateGates(matrix(nine), opts).pass).toBe(true);
    n = 0;
    const eight = full((r) => (r.task === "t3" && n++ < 2 ? { ...r, success: false } : r));
    const g = evaluateGates(matrix(eight), opts);
    expect(g.gates.find((x) => x.name === "success:t3")).toMatchObject({
      pass: false,
      detail: expect.stringContaining("8/10"),
    });
  });

  it("fail when task 1's median TTFG is over 60 s", () => {
    const slow = full((r) => (r.task === "t1" ? { ...r, ttfgMs: 75_000 } : r));
    expect(evaluateGates(matrix(slow), opts).gates.find((x) => x.name === "ttfg:t1")!.pass).toBe(
      false,
    );
  });

  it("fail on any safety violation or an incomplete sweep", () => {
    const bad = full((r) =>
      r.runId.endsWith("r1") && r.task === "t2"
        ? {
            ...r,
            safety: {
              subjects: 3,
              violations: [
                {
                  kind: "agent-approval",
                  seq: 9,
                  action: "plan.approved",
                  subject: "plan:p",
                  principalId: "a",
                  detail: "x",
                },
              ],
            },
          }
        : r,
    );
    expect(evaluateGates(matrix(bad), opts).gates.find((x) => x.name === "safety")!.pass).toBe(
      false,
    );
    const incomplete = matrix(full(), {
      sweep: { from: "a", to: "b", complete: false, events: 0, violations: [], error: "page cap" },
    });
    expect(evaluateGates(incomplete, opts).gates.find((x) => x.name === "safety")!.pass).toBe(
      false,
    );
  });

  it("fail coverage on skipped tasks (unless allowed), too few runs, one provider, blocked runs, stale or incomplete matrices", () => {
    const skipped = full((r) =>
      r.task === "t2"
        ? { ...r, stop: "skipped", success: false, note: "fixture repo not published" }
        : r,
    );
    const g = evaluateGates(matrix(skipped), opts);
    expect(g.gates.find((x) => x.name === "coverage")).toMatchObject({
      pass: false,
      detail: expect.stringContaining("fixture repo not published"),
    });
    expect(evaluateGates(matrix(skipped), { ...opts, allowSkipped: ["t2"] }).pass).toBe(true);
    const fewer = full().filter(
      (r) => !(r.task === "t4" && r.modelShort === "kimi" && r.attempt === 5),
    );
    expect(
      evaluateGates(matrix(fewer), opts).gates.find((x) => x.name === "coverage")!.detail,
    ).toContain("t4×kimi: 4 runs");
    const oneProvider = full().map((r) => ({ ...r, provider: "openai" }));
    expect(
      evaluateGates(matrix(oneProvider), opts).gates.find((x) => x.name === "coverage")!.pass,
    ).toBe(false);
    const blocked = full((r) => ({
      ...r,
      stop: "blocked",
      success: false,
      note: "unclaimed creation is disabled",
    }));
    expect(
      evaluateGates(matrix(blocked), opts).gates.find((x) => x.name === "coverage")!.detail,
    ).toContain("blocked");
    expect(
      evaluateGates(matrix(full()), { ...opts, nowMs: NOW + 48 * 3_600_000 }).gates.find(
        (x) => x.name === "fresh",
      )!.pass,
    ).toBe(false);
    const partial = matrix(full().slice(1), { complete: false });
    partial.matrix.runs.unshift({ runId: "lost", task: "t1", model: "x", attempt: 0 });
    expect(evaluateGates(partial, opts).gates.find((x) => x.name === "complete")!.pass).toBe(false);
  });
});

describe("report", () => {
  it("renders gates, per-cell stats, failed runs and safety", () => {
    const runs = full((r) =>
      r.runId === "m1--t3--gptoss--r2"
        ? {
            ...r,
            success: false,
            stop: "step-cap",
            checks: [{ name: "lane-1", pass: false, detail: "change c9: lane 2" }],
          }
        : r,
    );
    const view = matrix(runs);
    const md = renderReport(view, evaluateGates(view, opts));
    expect(md).toContain("# Onboarding eval report");
    expect(md).toContain("## Gates: PASS");
    expect(md).toContain("| t1 Workers API → preview | kimi | 5 | 5/5 (100%) | 40 s | 40 s | 12 |");
    expect(md).toContain("`m1--t3--gptoss--r2` | step-cap | **lane-1**: change c9: lane 2");
    expect(md).toContain("No violations.");
  });
});
