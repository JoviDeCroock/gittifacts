/**
 * Resolver eval: run the agent over the conflict corpus (fixtures/conflicts) with a REAL model.
 * NOT part of `pnpm test` (which runs the same pipeline with a scripted model).
 *
 *   CF_ACCOUNT_ID=… AI_GATEWAY_ID=… AI_GATEWAY_TOKEN=… pnpm --filter @app/resolver eval [case…]
 *
 * Optional env:
 *   RESOLVER_MODEL             policy model; "auto" (default) → the Auto Router's default pool
 *   AI_GATEWAY_FORMAT          "openai-chat" (default) | "anthropic-messages"
 *   AI_GATEWAY_ENDPOINT        full URL override
 *   AI_GATEWAY_ALLOWED_MODELS  comma list for the Auto Router pool
 *   BUDGET_USD                 per-case (per-change) budget, default 0.5
 *   CONCURRENCY                cases run in parallel, default 3
 *   REPORT                     also write the JSON report to this file
 *
 * Reports the success rate (spec gate: ≥ 80% on textual conflicts) and lane downgrades (must be
 * 0). Exit 1 when either gate fails. Spends real money, bounded by BUDGET_USD per case.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AiGatewayClient, type GatewayFormat } from "@app/tour";
import {
  buildRunner,
  type CaseResult,
  evaluateCase,
  listCases,
  scratchRoot,
} from "./lib/corpus.js";

type Env = Record<string, string | undefined>;
const runtime = globalThis as { process?: { argv: string[]; env: Env; exitCode?: number } };
const env: Env = runtime.process?.env ?? {};
const argv = runtime.process?.argv.slice(2) ?? [];

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}%`;
}

async function main(): Promise<void> {
  const missing = ["CF_ACCOUNT_ID", "AI_GATEWAY_ID", "AI_GATEWAY_TOKEN"].filter((k) => !env[k]);
  if (missing.length > 0) {
    console.log(
      `resolver eval: skipped (set ${missing.join(", ")} to run against a real AI Gateway)`,
    );
    return;
  }
  const allowed = env.AI_GATEWAY_ALLOWED_MODELS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const client = new AiGatewayClient({
    accountId: env.CF_ACCOUNT_ID!,
    gatewayId: env.AI_GATEWAY_ID!,
    apiToken: env.AI_GATEWAY_TOKEN!,
    model: env.RESOLVER_MODEL ?? "auto",
    ...(env.AI_GATEWAY_FORMAT ? { format: env.AI_GATEWAY_FORMAT as GatewayFormat } : {}),
    ...(env.AI_GATEWAY_ENDPOINT ? { endpoint: env.AI_GATEWAY_ENDPOINT } : {}),
    ...(allowed ? { allowedModels: allowed } : {}),
    requestTimeoutMs: 180_000,
  });
  const budgetUsd = Number(env.BUDGET_USD ?? "0.5");
  const concurrency = Math.max(1, Number(env.CONCURRENCY ?? "3"));
  const cases = listCases(argv);
  const root = scratchRoot("gittifacts-resolver-eval-");
  const results: CaseResult[] = [];
  try {
    const bundle = buildRunner(join(root, "runner"));
    for (let i = 0; i < cases.length; i += concurrency) {
      const batch = await Promise.all(
        cases
          .slice(i, i + concurrency)
          .map((c) => evaluateCase(c, { bundle, root, budgetUsd, client: () => client })),
      );
      for (const r of batch) {
        results.push(r);
        const lanes = r.lanes
          ? `lane ${r.lanes.before}→${r.lanes.merged}→${r.lanes.final}`
          : "lane -";
        const scope =
          r.outside === null
            ? ""
            : r.outside === r.expectedOutside
              ? " scope ok"
              : ` scope ${r.outside ? "outside" : "within"} (expected ${r.expectedOutside ? "outside" : "within"})`;
        const culprit =
          r.kind === "semantic"
            ? ` culprit ${r.culprit ?? "-"}${r.culprit === r.expectedCulprit ? "" : ` (expected ${r.expectedCulprit})`}`
            : "";
        console.log(
          `${r.success ? "PASS" : "FAIL"} ${r.name.padEnd(26)} ${r.kind.padEnd(8)} ${lanes} attempts ${r.attempts} $${r.costUsd.toFixed(4)} ${(r.durationMs / 1000).toFixed(1)}s${scope}${culprit}${r.failure ? `\n     ${r.failure.slice(0, 400)}` : ""}`,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const textual = results.filter((r) => r.kind === "textual");
  const semantic = results.filter((r) => r.kind === "semantic");
  const ok = (rs: CaseResult[]) => rs.filter((r) => r.success).length;
  const downgrades = results.filter((r) => r.downgrade).length;
  const summary = {
    model: results.find((r) => r.model)?.model ?? client.model,
    textual: {
      cases: textual.length,
      resolved: ok(textual),
      rate: pct(ok(textual), textual.length),
    },
    semantic: {
      cases: semantic.length,
      resolved: ok(semantic),
      rate: pct(ok(semantic), semantic.length),
    },
    laneDowngrades: downgrades,
    keptByFloor: results.filter((r) => r.keptByFloor).length,
    scopeMatches: results.filter((r) => r.outside !== null && r.outside === r.expectedOutside)
      .length,
    totalCostUsd: Number(results.reduce((n, r) => n + r.costUsd, 0).toFixed(4)),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (env.REPORT) {
    writeFileSync(
      env.REPORT,
      `${JSON.stringify({ summary, results: results.map(({ outcome: _, ...r }) => r) }, null, 2)}\n`,
    );
  }
  const gate = textual.length === 0 || ok(textual) / textual.length >= 0.8;
  if (runtime.process) runtime.process.exitCode = gate && downgrades === 0 ? 0 : 1;
}

await main();
