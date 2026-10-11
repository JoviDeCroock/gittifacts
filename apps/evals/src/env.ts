/** Bindings, vars and secrets of the `gittifacts-evals` Worker (wrangler.jsonc), and their parsing. */
import type { AiRunner } from "./agent/model.js";
import type { EvalSandbox } from "./sandbox.js";

export interface EvalEnv {
  AI: AiRunner;
  RESULTS: R2Bucket;
  EVAL_METRICS?: AnalyticsEngineDataset;
  EVAL_SANDBOX: DurableObjectNamespace<EvalSandbox>;
  EVAL_RUN_WORKFLOW: Workflow;
  EVAL_MATRIX_WORKFLOW: Workflow;

  PLATFORM_HOST: string;
  PREVIEW_HOST_SUFFIX: string;
  AI_GATEWAY_ID: string;
  EVAL_IMPORT_REPO_URL?: string;
  EVAL_RUNS_PER_CELL?: string;
  EVAL_CONCURRENCY?: string;
  EVAL_MAX_TOOL_CALLS?: string;
  EVAL_MAX_WALL_SEC?: string;
  EVAL_TOKEN_BUDGET?: string;
  EVAL_MODELS?: string;

  /** Platform agent token (repo:read, all repos) for the checkers. Never given to an agent. */
  EVAL_ADMIN_TOKEN?: string;
  /** Starts runs (POST /runs); also reads. */
  EVALS_API_TOKEN?: string;
  /** Reads results (CI gates). */
  EVALS_READ_TOKEN?: string;
  /** Signs `x-gittifacts-eval-sig` on agent traffic to the platform (optional). */
  EVAL_TRAFFIC_SECRET?: string;
}

export interface EvalConfig {
  host: string;
  previewSuffix: string;
  gatewayId: string;
  importRepoUrl: string | null;
  runsPerCell: number;
  concurrency: number;
  maxToolCalls: number;
  maxWallMs: number;
  tokenBudget: number;
  /** Re-check window after the agent stops (CI, previews and tours still finishing). */
  checkGraceMs: number;
}

function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function configOf(env: EvalEnv): EvalConfig {
  return {
    host: env.PLATFORM_HOST.replace(/\/+$/, ""),
    previewSuffix: (env.PREVIEW_HOST_SUFFIX || "-pv.resynapse.dev").toLowerCase(),
    gatewayId: env.AI_GATEWAY_ID || "gittifacts",
    importRepoUrl: env.EVAL_IMPORT_REPO_URL?.trim() || null,
    runsPerCell: int(env.EVAL_RUNS_PER_CELL, 5, 1, 20),
    concurrency: int(env.EVAL_CONCURRENCY, 4, 1, 20),
    maxToolCalls: int(env.EVAL_MAX_TOOL_CALLS, 60, 1, 200),
    maxWallMs: int(env.EVAL_MAX_WALL_SEC, 900, 60, 3600) * 1000,
    tokenBudget: int(env.EVAL_TOKEN_BUDGET, 2_500_000, 10_000, 10_000_000),
    checkGraceMs: 120_000,
  };
}

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Headers on agent traffic to the platform and its previews (never to other hosts): which run
 * this is, signed when `EVAL_TRAFFIC_SECRET` is set so the platform can key its per-IP creation
 * limits per eval run instead of per Cloudflare egress IP (README: platform follow-up). The
 * signature goes to the platform only: previews run project code, which could replay it.
 */
export async function evalHeaderFn(
  cfg: EvalConfig,
  runId: string,
  secret: string | undefined,
): Promise<(url: URL) => Record<string, string>> {
  const platform = new URL(cfg.host).hostname.toLowerCase();
  const sig = secret ? await hmacHex(secret, runId) : null;
  return (url) => {
    const h = url.hostname.toLowerCase();
    if (h !== platform && !h.endsWith(cfg.previewSuffix)) return {};
    const signed = sig !== null && h === platform;
    return { "x-gittifacts-eval-run": runId, ...(signed ? { "x-gittifacts-eval-sig": sig } : {}) };
  };
}
