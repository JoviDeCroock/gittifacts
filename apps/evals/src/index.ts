/**
 * `gittifacts-evals`: the onboarding eval (O6). Fresh agents get only `<platform>/start` and one
 * task; deterministic checkers verify the result; the nightly matrix gates releases.
 * See evals/onboarding/README.md.
 */
import type { EvalEnv } from "./env.js";
import { handle, startMatrix } from "./routes.js";

export { EvalSandbox } from "./sandbox.js";
export { EvalMatrixWorkflow } from "./workflows/matrix.js";
export { EvalRunWorkflow } from "./workflows/run.js";

export default {
  fetch(req, env) {
    return handle(req, env);
  },
  // Nightly: the full matrix (every task × model × EVAL_RUNS_PER_CELL).
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(startMatrix(env, { trigger: "cron" }).then(() => undefined));
  },
} satisfies ExportedHandler<EvalEnv>;
