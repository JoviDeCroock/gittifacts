/**
 * `plan <file>`: evaluate `.platform/ci.ts` in plan mode (the ci-engine recorder) and print the
 * static PipelineSpec. Without the file: the default pipeline for the checkout.
 *
 * The file is bundled with esbuild and evaluated in a child process (`__plan-eval`) with a hard
 * timeout; the recorder runs in that child next to the pipeline function.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultPipeline,
  PipelineSpec,
  PlanError,
  recordPipeline,
  resolvePipelineExport,
} from "../lib/ci-engine.js";
import { errorMessage, log } from "../lib/log.js";
import { bundleModule } from "../lib/module-eval.js";
import { run } from "../lib/proc.js";

export interface PlanFailure {
  error: string;
  file: string;
}
export type PlanDocument = PipelineSpec | PlanFailure;

const EVAL_PREFIX = "::gittifacts-plan-eval::";

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export interface PlanOptions {
  cwd: string;
  file: string;
  sha: string | null;
  baseSha: string | null;
  tmp: string;
  /** Path of this CLI, re-executed for the child evaluation. */
  self: string;
  timeoutMs?: number;
}

export async function plan(opts: PlanOptions): Promise<PlanDocument> {
  const path = resolve(opts.cwd, opts.file);
  if (!existsSync(path)) {
    log(`plan: ${opts.file} not found; using the default pipeline`);
    return defaultPipeline({
      rootEntries: listDir(opts.cwd),
      packageJson: readJson(join(opts.cwd, "package.json")),
      platformEntries: listDir(join(opts.cwd, ".platform")),
    });
  }
  const bundled = await bundleModule({ kind: "fs", path }, join(opts.tmp, "plan"));
  if (!bundled.ok)
    return { error: `cannot compile ${opts.file}: ${bundled.error}`, file: opts.file };
  const args = [opts.self, "__plan-eval", bundled.file];
  if (opts.sha !== null) args.push("--head", opts.sha);
  if (opts.baseSha !== null) args.push("--base", opts.baseSha);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const r = await run(process.execPath, args, {
    cwd: opts.cwd,
    timeoutMs,
    echo: false,
    env: { NODE_OPTIONS: undefined },
  });
  if (r.stderr.trim() !== "") log(`plan: ${r.stderr.trim().slice(-2000)}`);
  if (r.timedOut)
    return {
      error: `evaluating ${opts.file} did not finish within ${timeoutMs / 1000} s`,
      file: opts.file,
    };
  const line = r.stdout.split("\n").find((l) => l.startsWith(EVAL_PREFIX));
  if (line === undefined) {
    return {
      error: `evaluating ${opts.file} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-1500)}`,
      file: opts.file,
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(line.slice(EVAL_PREFIX.length));
  } catch (error) {
    return { error: `unreadable plan output: ${errorMessage(error)}`, file: opts.file };
  }
  if (
    payload !== null &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return { error: payload.error, file: opts.file };
  }
  const spec = PipelineSpec.safeParse(payload);
  if (!spec.success)
    return {
      error: `the recorded pipeline is invalid: ${spec.error.message.slice(0, 1500)}`,
      file: opts.file,
    };
  return spec.data;
}

/** Child side: import the bundle, record the pipeline, print the spec (or the error). */
export async function planEvalChild(
  bundle: string,
  sha: string | null,
  baseSha: string | null,
): Promise<void> {
  let out: unknown;
  try {
    const mod: unknown = await import(pathToFileURL(bundle).href);
    const fn = resolvePipelineExport(mod);
    out = await recordPipeline(fn, { context: { sha, baseSha }, timeoutMs: 30_000 });
  } catch (error) {
    out = {
      error:
        error instanceof PlanError
          ? error.message
          : `the pipeline file threw: ${errorMessage(error)}`,
    };
  }
  process.stdout.write(`\n${EVAL_PREFIX}${JSON.stringify(out)}\n`);
}
