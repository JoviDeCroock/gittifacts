/**
 * Run the reviewer against a real AI Gateway on the breaking-api scenario. NOT part of `pnpm test`.
 *
 *   CF_ACCOUNT_ID=… AI_GATEWAY_ID=… AI_GATEWAY_TOKEN=… pnpm --filter @app/tour live
 *
 * Optional env:
 *   REVIEWER_MODEL               policy.ai.reviewerModel ("auto" → cloudflare/auto). Default "auto".
 *   AI_GATEWAY_FORMAT            "openai-chat" (default) | "anthropic-messages"
 *   AI_GATEWAY_ENDPOINT          full URL override (e.g. the provider-native gateway URL)
 *   AI_GATEWAY_ALLOWED_MODELS    comma list for the Auto Router pool, e.g. "anthropic/claude-sonnet-5-5,anthropic/claude-opus-5-5"
 *   BUDGET_USD                   per-change budget. Default 0.5 (the policy default).
 *
 * Spends real money (bounded by BUDGET_USD and the gateway's spend limits).
 */
import { AiGatewayClient, createReviewer, type GatewayFormat } from "../src/index.js";
import { BREAKING_REASON, breakingApiInput, CHANGE_ID } from "../test/support/scenario.js";

type Env = Record<string, string | undefined>;
const runtime = globalThis as { process?: { env: Env; exitCode?: number } };
const env: Env = runtime.process?.env ?? {};

function done(code: number, message: string): void {
  console.log(message);
  if (runtime.process) runtime.process.exitCode = code;
}

async function main(): Promise<void> {
  const missing = ["CF_ACCOUNT_ID", "AI_GATEWAY_ID", "AI_GATEWAY_TOKEN"].filter((k) => !env[k]);
  if (missing.length > 0) {
    done(0, `live-tour: skipped (set ${missing.join(", ")} to run against a real AI Gateway)`);
    return;
  }
  const format = (env.AI_GATEWAY_FORMAT as GatewayFormat | undefined) ?? "openai-chat";
  const allowedModels = env.AI_GATEWAY_ALLOWED_MODELS?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const client = AiGatewayClient.fromEnv(env, {
    model: env.REVIEWER_MODEL ?? "auto",
    format,
    ...(allowedModels?.length ? { allowedModels } : {}),
  });
  const limitUsd = Number(env.BUDGET_USD ?? "0.5");
  const reviewer = createReviewer(client);
  console.log(`live-tour: model ${client.model} via ${client.url} (budget $${limitUsd})`);

  const input = breakingApiInput({ budget: { changeId: CHANGE_ID, limitUsd, spentUsd: 0 } });
  const judged = await reviewer.judge({ plan: input.plan, diff: input.diff, budget: input.budget });
  console.log("\n== judge", JSON.stringify(judged, null, 2));

  const outcome = await reviewer.tour({
    ...input,
    budget: { ...input.budget, spentUsd: judged.costUsd },
  });
  if (outcome.status !== "ok") {
    done(
      1,
      `\n== tour FAILED (budgetExceeded=${outcome.budgetExceeded}, $${outcome.costUsd}): ${outcome.reason}`,
    );
    return;
  }
  console.log("\n== tour", JSON.stringify(outcome.tour, null, 2));
  console.log("\n== readability", outcome.readability);
  console.log("== post-processing", JSON.stringify(outcome.diagnostics.postprocess, null, 2));
  console.log(
    `== cost $${(judged.costUsd + outcome.costUsd).toFixed(4)} (budgetExceeded=${outcome.budgetExceeded})`,
  );

  const firstRisk = outcome.tour.stops.find((s) => s.kind === "risk");
  const ok = firstRisk?.hunkRefs.some((r) => r.file === "src/format.ts") ?? false;
  done(
    ok ? 0 : 1,
    `\n== M3 acceptance (${BREAKING_REASON.code}): riskiest stop is ${ok ? "the breaking export" : "NOT the breaking export"}: ${firstRisk?.title ?? "(none)"}`,
  );
}

await main();
