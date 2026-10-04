/**
 * Model calls under the run's budget: every call is counted (tokens, dollars), a call that would
 * start past the budget is not made, and a failed or unreadable call is `null` (the caller falls
 * back to deterministic rules, which never produce a pass from nothing).
 */
import type { JsonSchema, LlmClient, LlmMetadata } from "@app/tour";
import type { z } from "zod";
import { parseModelJson } from "./script.js";

export class ModelSpend {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  usd = 0;
  /** The model that answered last (or the requested one). */
  model: string;
  lastError: string | null = null;

  constructor(
    private readonly llm: LlmClient | null,
    private readonly limitUsd: number,
    private readonly metadata: LlmMetadata,
  ) {
    this.model = llm?.model ?? "none";
  }

  get available(): boolean {
    return this.llm !== null && this.usd < this.limitUsd;
  }

  async ask<T>(input: {
    purpose: string;
    system: string;
    user: string;
    schema: z.ZodType<T>;
    jsonSchema: JsonSchema;
    maxTokens: number;
  }): Promise<T | null> {
    if (this.llm === null) {
      this.lastError = "no model available";
      return null;
    }
    if (this.usd >= this.limitUsd) {
      this.lastError = `over the run's model budget ($${this.limitUsd.toFixed(2)})`;
      return null;
    }
    try {
      const res = await this.llm.complete({
        system: input.system,
        messages: [{ role: "user", content: input.user }],
        jsonSchema: { name: input.purpose, schema: input.jsonSchema },
        maxTokens: input.maxTokens,
        metadata: { ...this.metadata, purpose: input.purpose },
      });
      this.calls++;
      this.inputTokens += res.usage.inputTokens;
      this.outputTokens += res.usage.outputTokens;
      this.usd += res.costUsd;
      this.model = res.model;
      const parsed = parseModelJson(input.schema, res);
      this.lastError = parsed === null ? `the model's ${input.purpose} answer was not valid` : null;
      return parsed;
    } catch (e) {
      this.calls++;
      this.lastError = `model call failed: ${e instanceof Error ? e.message : String(e)}`.slice(
        0,
        300,
      );
      return null;
    }
  }
}
