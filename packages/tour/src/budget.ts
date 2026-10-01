/**
 * Cost accounting for reviewer model calls.
 *
 * AI Gateway does not return a cost header (only `cf-aig-log-id`, cache status and, for the Auto
 * Router, `cf-aig-routed-model`), so cost is computed from token usage × a price table. Unknown
 * models are priced at the most expensive known rate: an unknown price may only make us stop
 * earlier, never spend more than the budget allows.
 *
 * The gateway's own spend-limit rules (partitioned by the `change_id` metadata key) remain the hard
 * backstop; this module is what lets the reviewer stop *before* a call and say so.
 */

/** USD per million tokens. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Prompt-cache reads (Anthropic schema only). Defaults to 10% of input. */
  cacheReadPerMTok?: number;
  /** Prompt-cache writes (Anthropic schema only). Defaults to 125% of input. */
  cacheWritePerMTok?: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

/**
 * Anthropic first-party list prices (cached 2026-09-25). Keys are bare model ids; lookups strip a
 * provider prefix such as `anthropic/`. Other providers in the Auto Router pool are not listed on
 * purpose: they fall back to {@link CEILING_PRICE} until an operator adds real prices.
 */
export const DEFAULT_PRICES: PriceTable = {
  "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

/** Price used for unknown models and for `cloudflare/auto` without an allow-list: the dearest known. */
export const CEILING_PRICE: ModelPrice = ceilingOf(Object.values(DEFAULT_PRICES));

export const AUTO_ROUTER_MODEL = "cloudflare/auto";

function ceilingOf(prices: readonly ModelPrice[]): ModelPrice {
  let inputPerMTok = 0;
  let outputPerMTok = 0;
  for (const p of prices) {
    inputPerMTok = Math.max(inputPerMTok, p.inputPerMTok);
    outputPerMTok = Math.max(outputPerMTok, p.outputPerMTok);
  }
  return { inputPerMTok, outputPerMTok };
}

/** `anthropic/claude-opus-5-5` → `claude-opus-5-5`; `@cf/x/y` stays as is. */
function bareModelId(model: string): string {
  if (model.startsWith("@cf/")) return model;
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

export interface PriceLookup {
  price: ModelPrice;
  /** false when the ceiling price was used because the model (or router pool) is unknown. */
  known: boolean;
}

/**
 * Price for a model id. For the Auto Router the routed model is not known before the call, so
 * the estimate is the ceiling over `allowedModels` when every one of them is priced, else the
 * global ceiling.
 */
export function priceFor(
  model: string,
  table: PriceTable = DEFAULT_PRICES,
  allowedModels?: readonly string[],
): PriceLookup {
  if (model === AUTO_ROUTER_MODEL) {
    if (allowedModels && allowedModels.length > 0 && !allowedModels.some((m) => m.includes("*"))) {
      const prices = allowedModels.map((m) => table[bareModelId(m)] ?? table[m]);
      if (prices.every((p): p is ModelPrice => p !== undefined)) {
        return { price: ceilingOf(prices), known: true };
      }
    }
    return { price: ceilingOf([CEILING_PRICE, ...Object.values(table)]), known: false };
  }
  const price = table[model] ?? table[bareModelId(model)];
  if (price !== undefined) return { price, known: true };
  return { price: ceilingOf([CEILING_PRICE, ...Object.values(table)]), known: false };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export function costOfUsage(model: string, usage: TokenUsage, table: PriceTable = DEFAULT_PRICES): number {
  const { price } = priceFor(model, table);
  const cacheRead = price.cacheReadPerMTok ?? price.inputPerMTok * 0.1;
  const cacheWrite = price.cacheWritePerMTok ?? price.inputPerMTok * 1.25;
  const usd =
    (usage.inputTokens * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      (usage.cacheReadInputTokens ?? 0) * cacheRead +
      (usage.cacheWriteInputTokens ?? 0) * cacheWrite) /
    1_000_000;
  return roundUsd(usd);
}

/**
 * Conservative token estimate: ~3 characters per token (code and JSON tokenize denser than
 * prose, and newer tokenizers use up to ~1.35× more tokens than older ones).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Worst-case cost of a call: estimated input plus the full `maxTokens` of output. */
export function estimateCallCostUsd(
  model: string,
  inputText: string,
  maxOutputTokens: number,
  table: PriceTable = DEFAULT_PRICES,
  allowedModels?: readonly string[],
): number {
  const { price } = priceFor(model, table, allowedModels);
  return roundUsd(
    (estimateTokens(inputText) * price.inputPerMTok + maxOutputTokens * price.outputPerMTok) / 1_000_000,
  );
}

/**
 * How many input tokens the remaining budget can pay for after reserving `maxOutputTokens` of
 * output. Never negative.
 */
export function affordableInputTokens(
  remainingUsd: number,
  model: string,
  maxOutputTokens: number,
  table: PriceTable = DEFAULT_PRICES,
  allowedModels?: readonly string[],
): number {
  const { price } = priceFor(model, table, allowedModels);
  const left = remainingUsd - (maxOutputTokens * price.outputPerMTok) / 1_000_000;
  if (left <= 0 || price.inputPerMTok <= 0) return left <= 0 ? 0 : Number.MAX_SAFE_INTEGER;
  return Math.floor((left * 1_000_000) / price.inputPerMTok);
}

export function roundUsd(usd: number): number {
  return Math.round(usd * 1e8) / 1e8;
}

/** Mirrors the coordinator's `Budget` port type (structurally identical). */
export interface ReviewerBudget {
  changeId: string;
  limitUsd: number;
  spentUsd: number;
}

/**
 * Tracks spend for one reviewer invocation on top of what the change had already spent.
 * `exceeded` latches: once a call was refused for budget, or actual spend went over the limit,
 * the invocation reports `budgetExceeded: true`.
 */
export class BudgetTracker {
  private spentThisRun = 0;
  private exceededFlag = false;

  constructor(private readonly budget: ReviewerBudget) {
    if (!(budget.spentUsd <= budget.limitUsd)) this.exceededFlag = true;
  }

  get limitUsd(): number {
    return this.budget.limitUsd;
  }

  /** Spent by the change in total, including this run. */
  get spentUsd(): number {
    return roundUsd(this.budget.spentUsd + this.spentThisRun);
  }

  /** Spent by this run only (what the reviewer reports as `costUsd`). */
  get costUsd(): number {
    return roundUsd(this.spentThisRun);
  }

  get remainingUsd(): number {
    return Math.max(0, roundUsd(this.budget.limitUsd - this.spentUsd));
  }

  get exceeded(): boolean {
    return this.exceededFlag;
  }

  /** The spec's rule: refuse when `spentUsd + estimate > limitUsd`. Refusal latches `exceeded`. */
  tryReserve(estimateUsd: number): boolean {
    if (!Number.isFinite(estimateUsd) || this.spentUsd + estimateUsd > this.budget.limitUsd) {
      this.exceededFlag = true;
      return false;
    }
    return true;
  }

  charge(costUsd: number): void {
    // A non-finite or negative cost is unknown: count it as the whole remaining budget.
    const cost = Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : this.remainingUsd;
    this.spentThisRun += cost;
    if (this.spentUsd > this.budget.limitUsd) this.exceededFlag = true;
  }

  /** The gateway refused for spend (HTTP 429) or similar: latch without charging. */
  markExceeded(): void {
    this.exceededFlag = true;
  }
}
