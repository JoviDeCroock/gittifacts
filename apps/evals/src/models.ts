/**
 * The agent models: two providers on Workers AI, called through AI Gateway by the AI binding
 * (DECISIONS.md "Reviewer model on this platform": third-party ids fail through the binding
 * without Unified Billing credits, so both providers are Workers AI-hosted).
 *
 * Prices are Workers AI's published rates (developers.cloudflare.com/workers-ai/platform/pricing,
 * read 2026-10-02): $0.011 per 1,000 neurons.
 */

export type ToolProtocol =
  /** OpenAI chat-completions `tools` / `tool_calls` (native function calling). */
  | "tools"
  /** Fallback: no `tools`; the model replies with one JSON action per turn (src/agent/protocol.ts). */
  | "json-actions";

export interface ModelDef {
  id: string;
  /** Short name for run ids, gateway metadata and reports. */
  short: string;
  provider: string;
  protocol: ToolProtocol;
  /** Completion cap per turn (reasoning included). */
  maxTokens: number;
  /** History is compacted above this many characters (older tool results are elided first). */
  contextChars: number;
  /** Neurons per million tokens. */
  neuronsPerM: { input: number; cachedInput: number; output: number };
}

export const USD_PER_1K_NEURONS = 0.011;

export const MODELS: readonly ModelDef[] = [
  {
    id: "@cf/moonshotai/kimi-k2.7-code",
    short: "kimi",
    provider: "moonshot",
    protocol: "tools",
    maxTokens: 8192,
    contextChars: 240_000,
    // $0.95 / M input, $0.19 / M cached input, $4.00 / M output.
    neuronsPerM: { input: 86_364, cachedInput: 17_273, output: 363_636 },
  },
  {
    id: "@cf/openai/gpt-oss-120b",
    short: "gptoss",
    provider: "openai",
    protocol: "tools",
    maxTokens: 8192,
    contextChars: 200_000,
    // $0.35 / M input, $0.75 / M output (no cached-input rate published: charged as input).
    neuronsPerM: { input: 31_818, cachedInput: 31_818, output: 68_182 },
  },
];

/** The configured models: `EVAL_MODELS` (comma-separated ids or short names), else all. */
export function selectModels(raw: string | undefined): ModelDef[] {
  const wanted = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.length === 0) return [...MODELS];
  const out: ModelDef[] = [];
  for (const w of wanted) {
    const m = findModel(w);
    if (!m) throw new Error(`unknown eval model: ${w}`);
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

export function findModel(idOrShort: string): ModelDef | undefined {
  return MODELS.find((m) => m.id === idOrShort || m.short === idOrShort);
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  /** Prompt tokens served from the provider's prefix cache (subset of `prompt`). */
  cached: number;
}

export function neuronsFor(model: ModelDef, u: TokenUsage): number {
  const uncached = Math.max(0, u.prompt - u.cached);
  const n =
    (uncached * model.neuronsPerM.input +
      u.cached * model.neuronsPerM.cachedInput +
      u.completion * model.neuronsPerM.output) /
    1_000_000;
  return Math.round(n);
}

export function usdForNeurons(neurons: number): number {
  return Math.round((neurons / 1000) * USD_PER_1K_NEURONS * 10_000) / 10_000;
}
