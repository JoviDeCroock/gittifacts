/**
 * The merge-queue fixture corpus (fixtures/queue): every scenario's affected sets, its pairwise
 * conflict matrix, which combinations git can merge, and — by actually running vitest on the
 * merged trees — which combinations pass (semantic conflicts, flaky tests).
 *
 * SKIP_QUEUE_RUNS=1 skips the vitest runs (~1 s each).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  git,
  listQueueScenarioNames,
  type MaterializedQueueScenario,
  materializeQueueScenario,
  type QueueOutcomeExpectation,
  REPO_ROOT,
} from "../../../scripts/lib/fixtures.js";
import {
  type AffectedSet,
  AffectedSet as AffectedSetSchema,
  conflictBetween,
} from "../src/index.js";
import { affectedBetween } from "./git-tree.js";

const SKIP_RUNS = process.env.SKIP_QUEUE_RUNS === "1";
const OUT = realpathSync(mkdtempSync(join(tmpdir(), "gittifacts-queue-")));
const VITEST = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");

afterAll(() => {
  // Best effort: a slow or failing cleanup of the scratch repos must not fail the suite.
  try {
    rmSync(OUT, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // left in the OS temp directory
  }
});

const names = listQueueScenarioNames();

it("the corpus has every required scenario", () => {
  expect(names).toEqual([
    "flaky-test",
    "independent",
    "overlapping-closure",
    "semantic-conflict",
    "shared-test-only",
    "stack",
    "textual-conflict",
  ]);
});

/** A clean env for a nested vitest (no inherited worker state). */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "VITEST" || k.startsWith("VITEST_") || k === "TEST" || k === "NODE_V8_COVERAGE")
      continue;
    if (k === "QUEUE_FLAKE_SEED") continue;
    env[k] = v;
  }
  return { ...env, CI: "1", NO_COLOR: "1", ...extra };
}

interface RunResult {
  pass: boolean;
  failing: string[];
  output: string;
}

function runVitest(dir: string, env: Record<string, string>): Promise<RunResult> {
  const report = join(dir, ".vitest-report.json");
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [VITEST, "run", "--root", dir, "--reporter=json", `--outputFile=${report}`],
      { cwd: dir, env: childEnv(env), maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let failing: string[] = [];
        if (existsSync(report)) {
          const json = JSON.parse(readFileSync(report, "utf8")) as {
            testResults: Array<{ name: string; status: string }>;
          };
          failing = json.testResults
            .filter((t) => t.status !== "passed")
            .map((t) => relative(dir, t.name))
            .sort();
        }
        resolve({ pass: error === null, failing, output: `${stdout}\n${stderr}` });
      },
    );
  });
}

/** A worktree of main with `changes` merged in. */
async function mergedWorktree(
  m: MaterializedQueueScenario,
  changes: readonly string[],
  tag: string,
) {
  const wt = join(OUT, `${m.scenario.name}-wt-${tag}`);
  await git(m.dir, ["worktree", "add", "-q", "--detach", wt, m.baseSha]);
  const branches = changes.map((id) => m.changes[id]?.branch ?? id);
  if (branches.length > 0) await git(wt, ["merge", "-q", "--no-edit", ...branches]);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(wt, "node_modules"));
  return wt;
}

const materialized = new Map<string, MaterializedQueueScenario>();
const affectedSets = new Map<string, Map<string, AffectedSet>>();

beforeAll(async () => {
  await Promise.all(
    names.map(async (name) => {
      const m = await materializeQueueScenario(name, { outDir: OUT });
      const sets = new Map<string, AffectedSet>();
      for (const c of m.scenario.changes) {
        const mc = m.changes[c.id];
        if (mc === undefined) throw new Error(`change ${c.id} was not materialized`);
        sets.set(c.id, affectedBetween(m.dir, mc.parentSha, mc.sha));
      }
      materialized.set(name, m);
      affectedSets.set(name, sets);
    }),
  );
});

describe.each(names)("queue scenario %s", (name) => {
  let m: MaterializedQueueScenario;
  let sets: Map<string, AffectedSet>;

  beforeAll(() => {
    m = materialized.get(name) as MaterializedQueueScenario;
    sets = affectedSets.get(name) as Map<string, AffectedSet>;
  });

  it("affected sets match scenario.json", () => {
    for (const c of m.scenario.changes) {
      const set = sets.get(c.id);
      expect(AffectedSetSchema.safeParse(set).success).toBe(true);
      const { analyzers, ...fields } = set as AffectedSet;
      expect(fields, `affected set of ${name}/${c.id}`).toEqual(m.scenario.expected.affected[c.id]);
      expect(analyzers.every((a) => a.complete)).toBe(fields.complete);
    }
  });

  it("the conflict matrix matches scenario.json", () => {
    for (const { pair, reasons } of m.scenario.expected.conflicts) {
      const [a, b] = pair.map((id) => sets.get(id) as AffectedSet) as [AffectedSet, AffectedSet];
      expect(conflictBetween(a, b)?.reasons ?? [], `${name}: ${pair.join(" vs ")}`).toEqual(
        reasons,
      );
      expect(conflictBetween(b, a)?.reasons ?? []).toEqual(reasons);
    }
  });

  it("git merges as scenario.json says", async () => {
    for (const { changes, clean } of m.scenario.expected.merges) {
      const branches = changes.map((id) => m.changes[id]?.branch ?? id);
      // merge-tree only takes two sides: fold the branches onto main one at a time.
      let tree = m.baseSha;
      let ok = true;
      for (const branch of branches) {
        const out = await new Promise<{ code: number; stdout: string }>((resolve) => {
          execFile(
            "git",
            [
              "-C",
              m.dir,
              "merge-tree",
              "--write-tree",
              "--allow-unrelated-histories",
              tree,
              branch,
            ],
            (error, stdout) =>
              resolve({
                code: error === null ? 0 : ((error as { code?: number }).code ?? 1),
                stdout,
              }),
          );
        });
        if (out.code !== 0) {
          ok = false;
          break;
        }
        // Continue from a commit of the merged tree so the next side merges against it.
        const treeId = out.stdout.trim().split("\n")[0] ?? "";
        tree = await git(m.dir, ["commit-tree", treeId, "-p", tree, "-p", branch, "-m", "merge"]);
      }
      expect(
        ok,
        `${name}: merging ${changes.join("+")} is ${clean ? "clean" : "conflicting"}`,
      ).toBe(clean);
    }
  });
});

// Every scenario's runs at once (suites run one after another; `.concurrent` only applies
// within one suite).
describe.runIf(!SKIP_RUNS).concurrent("test outcomes on merged trees", () => {
  it.each(names)(
    "%s: tests pass or fail as scenario.json says",
    async (name) => {
      const m = materialized.get(name) as MaterializedQueueScenario;
      const outcomes = m.scenario.expected.outcomes;
      // Worktrees one at a time (concurrent `git worktree add` in one repo races), runs at once.
      const trees: string[] = [];
      for (const [i, o] of outcomes.entries())
        trees.push(await mergedWorktree(m, o.changes, String(i)));
      const results = await Promise.all(
        outcomes.map((o: QueueOutcomeExpectation, i) => runVitest(trees[i] ?? "", o.env ?? {})),
      );
      outcomes.forEach((o, i) => {
        const r = results[i] as RunResult;
        const label = `${name}: tests on main + [${o.changes.join(", ")}] ${JSON.stringify(o.env ?? {})}`;
        expect(r.pass, `${label}\n${r.output.slice(-3000)}`).toBe(o.pass);
        expect(r.failing, label).toEqual(o.failing ?? []);
      });
    },
    120_000,
  );
});
