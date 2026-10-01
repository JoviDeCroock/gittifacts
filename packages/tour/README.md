# @app/tour

The reviewer agent. It writes the guided tour a human reads before approving a Lane 1/2 change,
and the LLM judgments (scope drift, plan conformance, hidden behavior change) the classifier uses
to raise a lane. It implements the coordinator's `Reviewer` port without depending on it.

The reviewer is not the author. Its prompts take plan, diff, evidence and classification, and
the input types have no field for `Change.claim.summary`. Tests check that a sentinel summary never
reaches a request.

```ts
import { createReviewer, reviewerLlmFromEnv, resolveReviewerModel } from "@app/tour";

const llm = reviewerLlmFromEnv(env, { model: policy.ai.reviewerModel }); // "auto" by default
const reviewer: Reviewer = createReviewer(llm, { principalId: "reviewer-agent" });
const judged = await reviewer.judge({ plan, diff, budget });
const toured = await reviewer.tour({ change, plan, diff, evidence, classification, budget });
```

## Model access

| Client | When | Needs |
|---|---|---|
| `AiBindingClient` | Default in the Worker | `env.AI` (Workers AI binding) + `AI_GATEWAY_ID` |
| `AiGatewayClient` | Fallback, or outside a Worker | `CF_ACCOUNT_ID`, `AI_GATEWAY_ID`, `AI_GATEWAY_TOKEN` |
| `FallbackLlmClient` | Both are configured | Tries the binding, then HTTP once. Never falls back on a budget refusal or a timeout |

`reviewerLlmFromEnv(env, opts)` picks the client.

Every call goes through AI Gateway with `cf-aig-metadata` / `gateway.metadata` =
`{ change_id, purpose, head, attempt, prompt }`. `change_id` is the key that per-change spend-limit
rules partition on.

### What the binding supports (workers-types 5.20261001.1, research §6)

- `env.AI.run(model, inputs, { gateway: { id, metadata, skipCache, cacheTtl, collectLog,
  requestTimeoutMs, retries } , extraHeaders, signal })`. `env.AI.aiGatewayLogId` holds the log id
  of the last call.
- **Workers AI models (`@cf/…`).** Current chat models (deepseek-v4, glm-5.x, qwen3.8,
  kimi-k2.x, gemma-4, gpt-oss) use the OpenAI chat-completions shapes, which is the default
  `jsonMode: "openai"`:
  - in: `response_format: { type: "json_schema", json_schema: { name, schema, strict } }`;
  - out: `choices[].message` + `usage`.

  Older models take `jsonMode: "workers-ai"` (`json_schema` is the bare schema). They return
  `{ response, usage? }`, and `response` may already be parsed JSON.
- **Third-party models** (`anthropic/claude-sonnet-5`, …) take the binding's untyped fallback
  overload. They are billed through Unified Billing, or a BYOK key under the alias `default`.
  The client sends the chat-completions input and reads whichever output shape comes back:
  chat completions, Anthropic messages, Responses, or legacy Workers AI.
- **Usage.** When usage is missing (some `@cf/…` models), tokens are estimated from text length
  and the response is marked `usageEstimated`. A missing usage is never treated as free.
- **Not verified:** `cloudflare/auto` on the binding (and on `/ai/v1/chat/completions`), and
  whether `extraHeaders` carries `cf-aig-allowed-models` to the Auto Router (research §9.6). The
  default pool below has one model, so it avoids both.

Workers AI bills in neurons, not per token. Add `@cf/…` prices through `prices` if you route
there. Until you do, unknown models are priced at the most expensive known rate ($10 / $50 per
MTok), which may stop the reviewer early but never lets it overspend.

## Model defaults

- Policy `ai.reviewerModel: "auto"` → the Auto Router `cloudflare/auto`, restricted to
  `DEFAULT_REVIEWER_POOL = ["anthropic/claude-sonnet-5"]` ($2 / $10 per MTok).
- A one-model pool needs no routing, so that model is called directly.
- `allowedModels: [...]` sets your own pool. `allowedModels: []` means the router's full pool.
  An explicit model id (e.g. `anthropic/claude-opus-5-5`) is used as given.
- **Why not Sonnet 5.5 or Haiku 4.5?** They are the cheapest current Anthropic models
  (`claude-sonnet-5-5` at $2 / $10, `claude-haiku-4-5` at $1 / $5). But neither appears in the Auto
  Router pool documented on 2026-10-01, and an allow-list entry the pool lacks fails every
  request with HTTP 400.
  - Claude Sonnet 5 is in the default pool at the same price as Sonnet 5.5.
  - Once Cloudflare lists Sonnet 5.5 or Haiku 4.5, swap them in. The ceiling stays $2 / $10, so
    the arithmetic below does not change.
  - The gateway catalog spells versions with dots (`claude-opus-5.5`). Price lookups normalize
    those, and dated snapshot ids, to the API ids.

## Budget

The rules:
1. **Estimate before each call:** input ≈ prompt characters / 3 tokens × input price, plus the
   full `maxTokens` × output price (worst case). For the Auto Router, the price is the most
   expensive model in the pool.
2. **Refuse** the call when `budget.spentUsd + estimate > budget.limitUsd`. The reviewer then
   returns `budgetExceeded: true` and never skips silently.
3. **Charge the actual cost** after each call: `usage` × price of the model that answered.
   - If that pushes spend over the limit, the paid-for result is kept and `budgetExceeded` is
     reported.
   - An HTTP 429 from the gateway (spend-limit rule, or a rate limit) also counts as exceeded.
4. **Fit the diff to what is left:** `D ≤ (remaining − M·out) / in − O`, capped at 24k tokens
   (tour) or 16k (judge). If not even the minimum fits, the reviewer refuses with
   `budgetExceeded`.
5. **Reserve one regeneration for small diffs.** If the full diff is under 8,000 tokens, size it
   so both calls fit at worst case:
   - Call 1 costs `(O + D)·in + M·out` and the regeneration costs `(O + D + R)·in + M·out`.
   - Both fit when `D ≤ ((remaining − 2M·out) / in − R) / 2 − O`.
   - If even that leaves less than the minimum diff, the single-call fit (rule 4) applies.
   - Larger diffs keep rule 4, so the review never loses diff for a regeneration that may not
     be needed.

Symbols:

| Symbol | Meaning | Value |
|---|---|---|
| `in`, `out` | Price per input / output token | Default pool: $2 / $10 per MTok |
| `M` | Output tokens per call | tour 6,000; judge 1,500 |
| `O` | Prompt without the diff, plus 128 slack | ≈ 2–4k tokens. System prompt ≈ 1.1k; the breaking-api fixture totals ≈ 2.0k |
| `R` | Extra regeneration input | ≤ 4.8k (previous reply clipped to 12k chars ≈ 4k, plus the retry message) |

Worst case at the default $0.50, default pool, with `O` = 4k:

| Call | Input tokens | Cost |
|---|---|---|
| Judge (16k diff cap) | ≤ 17k | 17k·$2/M + 1.5k·$10/M = **$0.049** |
| Tour, 8k diff | 12k | 12k·$2/M + 6k·$10/M = **$0.084** |
| Regeneration, 8k diff | 16.8k | **$0.094** |
| Tour, 24k diff (cap) | 28k | **$0.116** |
| Regeneration, 24k diff | 32.8k | **$0.126** |

- **Small diff:** judge + tour + regeneration = **$0.227**.
- **Largest diff:** judge + tour + regeneration = **$0.291**.

Both are under $0.50, so with the default pool every tour gets its regeneration with the whole
diff. For an 8k diff, the reserve in rule 5 only starts trimming when less than about $0.18
remains: `(2·(4k + 8k) + 4.8k)·$2/M + 2·6k·$10/M = $0.178`.

The same flow with the router's full pool shows why the default pool exists. The ceiling is
Claude Fable 5 at $10 / $50:
- the output reserve alone is 6k × $50/M = **$0.30 per tour call**;
- the judge costs up to $0.245;
- so a regeneration can never fit within $0.50, and the first call's diff gets squeezed.

## Tours

`postprocess.ts` documents the guarantees in full. In short:
- Stops are ordered intent → behavior → risk/proof → other → transform → uncovered.
- A `proven` verdict needs a usable evidence id. Unknown refs are dropped and noted.
- Verified-transform files become one stop written by the platform.
- A merge-queue conflict resolution (`conflict-resolution` evidence) becomes one platform-written
  `resolution` stop, placed right after the riskiest stop and never dropped by the stop cap. It
  lists the upstream changes, whether the resolver edited lines outside the conflict hunks, and
  the semantic-conflict culprit. Its verdict is `risk` when the resolution edited outside its
  hunks, was semantic or failed; otherwise `proven` only when the merged tree's tests passed
  (`mergedTreeTestsPassed`), else `unproven`. The model is told the stop exists and gets one stop
  less.
- The riskiest hunk leads the risk stops whenever a Lane-2 reason is anchored to it.
- Caps: Lane 1 is ≤ 450 words and ≤ 7 stops (≈ 171 s on a phone at most); Lane 2 is ≤ 900
  words and ≤ 12 stops.
- `readability.estimatedReadSeconds` is on the result.

## Tests

`pnpm --filter @app/tour test` covers:
- every rule above, with `FakeLlmClient` and a fake `Ai` binding;
- an M3 acceptance check against the real classifier: in breaking-api, the riskiest stop is the
  breaking export.

`pnpm --filter @app/tour live` runs the breaking-api tour against a real AI Gateway. It needs
`CF_ACCOUNT_ID`, `AI_GATEWAY_ID`, `AI_GATEWAY_TOKEN`, spends real money, and is not part of
`pnpm test`.
