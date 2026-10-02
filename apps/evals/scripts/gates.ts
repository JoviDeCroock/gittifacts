/**
 * `pnpm --filter @app/evals gates [-- options]`: evaluates the §7 gates on the latest complete
 * nightly matrix (or `--matrix <id>` / `--file <view.json>`). Exit 0 = release may proceed;
 * 1 = a gate failed (release blocked); 2 = the results could not be read (also blocks).
 *
 *   --allow-skipped t2     tolerate a task that did not run (interim only)
 *   --max-age-hours 36     the matrix must be this fresh (0 = don't check)
 *   --trigger cron|manual  which matrices count as "latest" (default cron)
 *   --json                 print the gate results as JSON
 */
import { DEFAULT_GATES, evaluateGates } from "../src/gates.js";
import { isTaskId, type TaskId } from "../src/tasks.js";
import { args, loadView } from "./source.js";

async function main(): Promise<number> {
  const a = args({
    "allow-skipped": { type: "string", multiple: true },
    "max-age-hours": { type: "string" },
    json: { type: "boolean" },
  });
  const allow = (a["allow-skipped"] ?? []).flatMap((s) => s.split(","));
  const bad = allow.filter((t) => !isTaskId(t));
  if (bad.length) throw new Error(`unknown task in --allow-skipped: ${bad.join(", ")}`);
  const maxAge =
    a["max-age-hours"] === undefined ? DEFAULT_GATES.maxAgeHours : Number(a["max-age-hours"]);
  const view = await loadView(a);
  const result = evaluateGates(view, {
    ...DEFAULT_GATES,
    allowSkipped: allow as TaskId[],
    maxAgeHours: maxAge === 0 ? null : maxAge,
    nowMs: Date.now(),
  });
  if (a.json) {
    console.log(JSON.stringify({ matrixId: view.matrix.matrixId, ...result }, null, 2));
  } else {
    console.log(
      `Onboarding eval gates — matrix ${view.matrix.matrixId} (${view.matrix.createdAt})`,
    );
    for (const g of result.gates)
      console.log(`${g.pass ? "PASS" : "FAIL"}  ${g.name.padEnd(12)} ${g.detail}`);
    console.log(result.pass ? "\nAll gates pass." : "\nGates failed: release blocked.");
  }
  return result.pass ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`gates: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  },
);
