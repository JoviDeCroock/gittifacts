/**
 * Live judge calibration: every case in test/judge-calibration through the REAL judge (prompt,
 * rendering, parsing, citation rule) and a REAL Workers AI model. NOT part of `pnpm test`.
 *
 *   pnpm --filter @app/tour exec tsx scripts/calibrate-judge.ts [case-id-substring …]
 *
 * The model is called through the production `AiBindingClient` (same inputs, same JSON mode),
 * with its `env.AI` binding replaced by one of two transports. Nothing goes through AI Gateway.
 * - TRANSPORT=cf (default without CF_ACCOUNT_ID): `cf ai run <model> --body <inputs>`, with the
 *   cf CLI's own login. The CLI gives up after ~30 s, which a reasoning model can exceed.
 * - TRANSPORT=rest (default with CF_ACCOUNT_ID): `POST /accounts/{CF_ACCOUNT_ID}/ai/run/{model}`
 *   with Wrangler's OAuth token (`wrangler auth token`), held in memory only, never printed.
 *
 * Env:
 *   JUDGE_MODEL   default @cf/moonshotai/kimi-k2.7-code (the platform's "auto" reviewer model)
 *   RUNS          runs per case (default 1): the model samples, so repeat to see variance
 *   CONCURRENCY   cases in flight (default 3)
 *   OUT           write the full results as JSON to this path
 *   MAX_TOKENS    judge output-token limit (default: the reviewer's default)
 *
 * Costs fractions of a cent per call (Kimi K2.7 Code ≈ $0.0006 per small call, DECISIONS.md).
 */
import { type AiBinding, AiBindingClient, createReviewer, DEFAULT_PRICES } from "../src/index.js";
import type { JudgeOutcome } from "../src/schema.js";
import {
  CALIBRATION_CASES,
  type CalibrationCase,
  calibrationPlan,
  passes,
  worstOutcome,
} from "../test/support/calibration.js";

type Env = Record<string, string | undefined>;
const runtime = globalThis as {
  process?: { env: Env; argv: string[]; exitCode?: number };
};
const env: Env = runtime.process?.env ?? {};
const argv = runtime.process?.argv.slice(2) ?? [];

const MODEL = env.JUDGE_MODEL ?? "@cf/moonshotai/kimi-k2.7-code";
const RUNS = Math.max(1, Number(env.RUNS ?? "1") || 1);
const CONCURRENCY = Math.max(1, Number(env.CONCURRENCY ?? "3") || 3);
const MAX_TOKENS = env.MAX_TOKENS ? Number(env.MAX_TOKENS) : undefined;
const TRANSPORT = env.TRANSPORT ?? (env.CF_ACCOUNT_ID ? "rest" : "cf");
/** Conservative Workers AI estimate, as in apps/platform (WORKERS_AI_PRICES). */
const PRICES = { ...DEFAULT_PRICES, [MODEL]: { inputPerMTok: 1, outputPerMTok: 5 } };

type ExecFile = (
  file: string,
  args: readonly string[],
  opts: { maxBuffer: number; timeout: number },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

/** Node's child_process without @types/node (this package typechecks against workers-types). */
async function execFile(): Promise<ExecFile> {
  const specifier = "node:child_process";
  const mod = (await import(specifier)) as { execFile: ExecFile };
  return mod.execFile;
}

/** An `env.AI` stand-in: runs the same inputs through `cf ai run`. */
function cfCliBinding(exec: ExecFile, onPayload: (payload: unknown) => void): AiBinding {
  return {
    run: (model, inputs) =>
      new Promise((resolve, reject) => {
        exec(
          "cf",
          ["ai", "run", model, "--body", JSON.stringify(inputs)],
          { maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
          (err, stdout, stderr) => {
            if (err) {
              const code = (err as { code?: unknown; signal?: unknown }).code ?? "?";
              const tail = `${stderr} ${stdout}`.replace(/\s+/g, " ").trim().slice(-400);
              reject(new Error(`cf ai run failed (exit ${String(code)}): ${tail}`));
              return;
            }
            try {
              const start = stdout.indexOf("{");
              const payload: unknown = JSON.parse(stdout.slice(start));
              onPayload(payload);
              resolve(payload);
            } catch {
              reject(new Error(`cf ai run returned non-JSON: ${stdout.slice(0, 300)}`));
            }
          },
        );
      }),
  };
}

let token: Promise<string> | null = null;

/** Wrangler's current OAuth token, for the REST transport. Kept in memory, never printed. */
function wranglerToken(exec: ExecFile): Promise<string> {
  token ??= new Promise((resolve, reject) => {
    exec(
      "pnpm",
      ["-w", "exec", "wrangler", "auth", "token", "--json"],
      { maxBuffer: 1024 * 1024, timeout: 60_000 },
      (err, stdout) => {
        try {
          if (err) throw err;
          const parsed = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { token?: unknown };
          if (typeof parsed.token !== "string" || parsed.token === "") throw new Error("no token");
          resolve(parsed.token);
        } catch {
          reject(new Error("wrangler auth token failed: run `wrangler login`"));
        }
      },
    );
  });
  return token;
}

/** An `env.AI` stand-in over the Workers AI REST API (`result` holds the binding's output). */
function restBinding(
  exec: ExecFile,
  accountId: string,
  onPayload: (payload: unknown) => void,
): AiBinding {
  return {
    run: async (model, inputs) => {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${await wranglerToken(exec)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(inputs),
          signal: AbortSignal.timeout(300_000),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        result?: unknown;
        success?: boolean;
        errors?: unknown;
      };
      if (!res.ok || body.success === false) {
        throw new Error(
          `Workers AI HTTP ${res.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`,
        );
      }
      onPayload(body.result);
      return body.result;
    },
  };
}

interface RunResult {
  id: string;
  expected: CalibrationCase["expected"];
  run: number;
  outcomes: Record<string, JudgeOutcome>;
  worst: JudgeOutcome;
  pass: boolean;
  /** Citations as the model sent them, per question. */
  modelCitations: Record<string, unknown[]>;
  /** Rationale and note after the citation rule, per question. */
  judged: Record<string, { rationale: string; note?: string }>;
  downgraded: string[];
  /** Whether a kept concern cites one of the case's `concernAt` hunks. */
  citesExpectedHunk: boolean | null;
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;
  error?: string;
}

function modelJudgments(payload: unknown): Array<{ question?: string; citations?: unknown[] }> {
  try {
    const text = (payload as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]
      ?.message?.content;
    const json = JSON.parse(text ?? "") as { judgments?: unknown };
    return Array.isArray(json.judgments) ? (json.judgments as never[]) : [];
  } catch {
    return [];
  }
}

async function runCase(exec: ExecFile, c: CalibrationCase, run: number): Promise<RunResult> {
  let payload: unknown;
  const client = new AiBindingClient({
    ai:
      TRANSPORT === "rest"
        ? restBinding(exec, env.CF_ACCOUNT_ID ?? "", (p) => {
            payload = p;
          })
        : cfCliBinding(exec, (p) => {
            payload = p;
          }),
    gatewayId: "calibration-not-used",
    model: MODEL,
    prices: PRICES,
  });
  const reviewer = createReviewer(client, {
    prices: PRICES,
    ...(MAX_TOKENS ? { maxOutputTokens: { judge: MAX_TOKENS } } : {}),
  });
  const out = await reviewer.judge({
    plan: calibrationPlan(c),
    diff: c.diff,
    budget: { changeId: `calibration-${c.id}`, limitUsd: 1, spentUsd: 0 },
  });
  const outcomes: Record<string, JudgeOutcome> = {};
  const judged: RunResult["judged"] = {};
  const downgraded: string[] = [];
  for (const j of out.items) {
    outcomes[j.question] = j.outcome;
    judged[j.question] = { rationale: j.rationale, ...(j.note ? { note: j.note } : {}) };
    if (j.note?.includes("concern downgraded")) downgraded.push(j.question);
  }
  const modelCitations: Record<string, unknown[]> = {};
  for (const m of modelJudgments(payload)) {
    if (typeof m.question === "string") modelCitations[m.question] = m.citations ?? [];
  }
  const worst = worstOutcome(Object.values(outcomes));
  const kept = out.items.filter((j) => j.outcome === "concern").map((j) => j.rationale);
  const citesExpectedHunk =
    c.concernAt === undefined || worst !== "concern"
      ? null
      : c.concernAt.some((at) => kept.some((r) => r.includes(`${at.file} hunk ${at.hunk} (`)));
  const call = out.calls[0];
  const error = out.items.find((j) => j.status === "error")?.note;
  const finish = (payload as { choices?: Array<{ finish_reason?: string }> } | undefined)
    ?.choices?.[0]?.finish_reason;
  return {
    id: c.id,
    expected: c.expected,
    run,
    outcomes,
    worst,
    pass: passes(c.expected, worst),
    modelCitations,
    judged,
    downgraded,
    citesExpectedHunk,
    inputTokens: call?.inputTokens ?? 0,
    outputTokens: call?.outputTokens ?? 0,
    ...(finish ? { stopReason: finish } : {}),
    ...(error ? { error } : {}),
  };
}

const SHORT: Record<JudgeOutcome, string> = { "no-concern": "ok", unsure: "??", concern: "!!" };

function compactCitations(r: RunResult): string {
  const parts: string[] = [];
  for (const [q, cites] of Object.entries(r.modelCitations)) {
    for (const raw of cites) {
      const c = raw as { file?: string; hunk?: unknown; planBasis?: string };
      parts.push(
        `${q.split("-")[0]}:${c.file ?? "?"}#${String(c.hunk ?? "?")}/${c.planBasis ?? "?"}`,
      );
    }
  }
  return parts.length > 0 ? parts.join(" ") : "-";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function pool<T, R>(items: readonly T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function main(): Promise<void> {
  const filters = argv.filter((a) => !a.startsWith("-"));
  const cases = CALIBRATION_CASES.filter(
    (c) => filters.length === 0 || filters.some((f) => c.id.includes(f)),
  );
  if (TRANSPORT === "rest" && !env.CF_ACCOUNT_ID) {
    console.log("calibrate-judge: TRANSPORT=rest needs CF_ACCOUNT_ID");
    if (runtime.process) runtime.process.exitCode = 2;
    return;
  }
  const exec = await execFile();
  const jobs = cases.flatMap((c) =>
    Array.from({ length: RUNS }, (_, run) => ({ c, run: run + 1 })),
  );
  console.log(
    `judge calibration: ${cases.length} case(s) × ${RUNS} run(s) on ${MODEL} via ${TRANSPORT}${MAX_TOKENS ? `, max ${MAX_TOKENS} output tokens` : ""}\n`,
  );
  const results = await pool(jobs, CONCURRENCY, ({ c, run }) =>
    runCase(exec, c, run).catch(
      (err: unknown): RunResult => ({
        id: c.id,
        expected: c.expected,
        run,
        outcomes: {},
        worst: "unsure",
        pass: false,
        modelCitations: {},
        judged: {},
        downgraded: [],
        citesExpectedHunk: null,
        inputTokens: 0,
        outputTokens: 0,
        error: err instanceof Error ? err.message : String(err),
      }),
    ),
  );

  console.log(
    `${pad("case", 40)} ${pad("expected", 16)} S  P  H  ${pad("worst", 10)} pass  hit  ${pad("out", 5)} citations (model, before the rule)`,
  );
  for (const r of results) {
    const o = (q: string) => (r.outcomes[q] ? SHORT[r.outcomes[q]] : "--");
    const hit = r.citesExpectedHunk === null ? "  - " : r.citesExpectedHunk ? " yes" : "  no";
    const extra = [
      r.downgraded.length > 0 ? `downgraded: ${r.downgraded.join(",")}` : "",
      r.stopReason && r.stopReason !== "stop" ? `finish=${r.stopReason}` : "",
      r.error ? `ERROR ${r.error.slice(0, 160)}` : "",
    ].filter(Boolean);
    console.log(
      `${pad(`${r.id}${RUNS > 1 ? `#${r.run}` : ""}`, 40)} ${pad(r.expected, 16)} ${o("scope-drift")} ${o("plan-conformance")} ${o("hidden-behavior-change")} ${pad(r.worst, 10)} ${r.pass ? "PASS" : "FAIL"} ${hit}  ${pad(String(r.outputTokens), 5)} ${compactCitations(r)}${extra.length > 0 ? `  [${extra.join("; ")}]` : ""}`,
    );
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\npass rate: ${passed}/${results.length}`);
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`\n--- ${r.id} (expected ${r.expected}, got ${r.worst})`);
    for (const [q, j] of Object.entries(r.judged)) {
      console.log(
        `  ${q}: ${r.outcomes[q]} — ${j.rationale.slice(0, 600)}${j.note ? `\n    note: ${j.note}` : ""}`,
      );
    }
  }
  if (env.OUT) {
    const specifier = "node:fs";
    const fs = (await import(specifier)) as { writeFileSync(p: string, d: string): void };
    fs.writeFileSync(env.OUT, `${JSON.stringify({ model: MODEL, results }, null, 2)}\n`);
    console.log(`\nwrote ${env.OUT}`);
  }
  if (runtime.process) runtime.process.exitCode = passed === results.length ? 0 : 1;
}

void main();
