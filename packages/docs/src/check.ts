/**
 * `pnpm --filter @app/docs check`: links, samples (tool calls, CLI commands, JSON), generated
 * pages current, page length and style. Exits 1 on any problem; known issues in quoted code
 * (see KNOWN_ISSUES) are printed as warnings.
 */
import { runChecks } from "./check/index.js";
import { formatProblem } from "./check/problem.js";

const t0 = Date.now();
const { problems, known, pages } = await runChecks();
for (const p of known) console.warn(`warning (known): ${formatProblem(p)}`);
for (const p of problems) console.error(formatProblem(p));
const summary = `docs check: ${pages} pages, ${problems.length} problem(s), ${known.length} known issue(s), ${Date.now() - t0} ms`;
if (problems.length > 0) {
  console.error(summary);
  process.exit(1);
}
console.log(summary);
