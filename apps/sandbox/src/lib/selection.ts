/**
 * Test selection for evidence: run the tests that can reach the Change, not the whole suite.
 *
 * The targets are `@app/affected`'s test targets for base..head: test files whose import closure
 * meets the touched files (plus touched tests, and every test under a runner config or Workers
 * pool whose setup/entry the Change reaches). Unknown impact runs everything: an incomplete
 * analysis, a config/manifest change (`*`), or a crash. That is the escalate rule; a selection
 * can only ever be narrower when the analysis says it is complete.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ALL_TESTS } from "@app/affected";
import type { TestSelection } from "@app/evidence";
import { computeAffected } from "../commands/affected.js";
import type { Context } from "./context.js";
import { errorMessage, log } from "./log.js";

export interface Selection {
  mode: "all" | "affected";
  /** Repo-relative test files to run (mode `affected`; may be empty: nothing reaches the Change). */
  files: string[];
  reason: string;
}

const all = (reason: string): Selection => ({ mode: "all", files: [], reason });

/** Which test files the measurements of this Change run. Never throws. */
export async function selectTests(ctx: Context): Promise<Selection> {
  if (process.env.GITTIFACTS_TEST_SELECTION === "all")
    return all("the whole suite (GITTIFACTS_TEST_SELECTION=all)");
  try {
    const set = await computeAffected(ctx, {
      cwd: ctx.repo,
      coverageMap: process.env.GITTIFACTS_COVERAGE_MAP || undefined,
      publicApiEvidence: undefined,
    });
    const impact = set.analyzers.find((a) => a.name === "test-impact")?.note;
    if (!set.complete) {
      const why = set.analyzers.find((a) => !a.complete)?.note ?? "an analyzer was incomplete";
      return all(`the whole suite: the Change's test impact is unknown (${why})`);
    }
    if (set.testTargets.includes(ALL_TESTS))
      return all(`the whole suite: ${impact ?? "every test is affected"}`);
    const files = set.testTargets.filter((f) => existsSync(join(ctx.repo, f)));
    const selection: Selection = {
      mode: "affected",
      files,
      reason:
        files.length === 0
          ? "no test file reaches the changed files (static import closure)"
          : `${files.length} test file(s) that reach the changed files${impact ? ` (${impact})` : ""}`,
    };
    log(`test selection: ${selection.reason}`);
    return selection;
  } catch (error) {
    return all(`the whole suite: test impact analysis failed (${errorMessage(error)})`);
  }
}

/** The selection as recorded in evidence. */
export function selectionEvidence(s: Selection): TestSelection {
  return {
    mode: s.mode,
    reason: s.reason.slice(0, 1000),
    ...(s.mode === "affected" ? { files: s.files.length, tests: s.files.slice(0, 200) } : {}),
  };
}

/** `files` for `runTests`: undefined runs the whole suite. */
export function selectedFiles(s: Selection): string[] | undefined {
  return s.mode === "all" ? undefined : s.files;
}
