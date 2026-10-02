/**
 * `pnpm --filter @app/evals report [-- options]`: writes evals/onboarding/report.md from the
 * latest complete nightly matrix (or `--matrix <id>` / `--file <view.json>`; `--incomplete` to
 * include a matrix still running). `--out <path>` writes elsewhere; `--stdout` prints instead.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_GATES, evaluateGates } from "../src/gates.js";
import { renderReport } from "../src/report.js";
import { args, loadView } from "./source.js";

const DEFAULT_OUT = resolve(import.meta.dirname, "../../../evals/onboarding/report.md");

async function main(): Promise<void> {
  const a = args({ out: { type: "string" }, stdout: { type: "boolean" } });
  const view = await loadView(a);
  const gates = evaluateGates(view, { ...DEFAULT_GATES, maxAgeHours: null, nowMs: Date.now() });
  const md = renderReport(view, gates);
  if (a.stdout) {
    process.stdout.write(md);
    return;
  }
  const out = a.out ? resolve(a.out) : DEFAULT_OUT;
  await writeFile(out, md);
  console.log(
    `wrote ${out} (matrix ${view.matrix.matrixId}, gates ${gates.pass ? "pass" : "FAIL"})`,
  );
}

main().catch((e: unknown) => {
  console.error(`report: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
