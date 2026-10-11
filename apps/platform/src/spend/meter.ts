/**
 * The spend meter: every paid resource the platform uses is priced (./prices.ts) and recorded at
 * one seam per resource, so a runaway shows up in one place.
 *
 *   ci          every Runner container (CI steps, plan and sandbox jobs): src/spend/runner.ts
 *   workspace   remote workspaces' container time: src/workspace/workspace-do.ts
 *   preview     preview containers (heartbeat while running): src/previews/preview-host.ts
 *   llm         model calls (judge, tour, resolver, QA): src/limits/coordinator-do.ts
 *   browser     Browser Run (QA, preview screenshots): src/qa/finish.ts, src/previews/port.ts
 *
 * Each record goes three ways: the `spend` ProjectLedger's day counters (micro-USD per source,
 * strongly consistent; what the breaker reads, src/spend/breaker.ts), one Analytics Engine data
 * point (history, per project), and one JSON log line (`{"spend": …}`, Workers Logs). Recording
 * never throws: a lost record is logged, never fails the work it measured.
 */
import type { ProjectLedger } from "../workspace/ledger-do.js";

export const SPEND_SOURCES = ["ci", "workspace", "preview", "llm", "browser"] as const;
export type SpendSource = (typeof SPEND_SOURCES)[number];

/** The ProjectLedger instance that sums the platform's spend per UTC day. */
export const SPEND_LEDGER = "spend";

export interface SpendEnv {
  PROJECT_LEDGER: DurableObjectNamespace<ProjectLedger>;
  METRICS?: Pick<AnalyticsEngineDataset, "writeDataPoint">;
}

export interface SpendRecord {
  source: SpendSource;
  usd: number;
  /** The project it was for, when known. */
  repoId?: string | null;
  /** What it was: a run and step, a workspace, a change… (logs only). */
  ref?: string;
  atMs?: number;
}

const metric = (source: SpendSource) => `usd-micros:${source}`;

export async function recordSpend(env: SpendEnv, r: SpendRecord): Promise<void> {
  const usd = Number.isFinite(r.usd) && r.usd > 0 ? r.usd : 0;
  if (usd === 0) return;
  const atMs = r.atMs ?? Date.now();
  const micros = Math.max(1, Math.round(usd * 1e6));
  console.log(
    JSON.stringify({
      spend: { source: r.source, usd: micros / 1e6, repoId: r.repoId ?? null, ref: r.ref ?? null },
    }),
  );
  try {
    env.METRICS?.writeDataPoint({
      indexes: [r.source],
      blobs: [r.source, r.repoId ?? "", r.ref ?? "", "spend"],
      doubles: [usd],
    });
  } catch (e) {
    console.warn("spend: analytics write failed", e);
  }
  try {
    const ledger = env.PROJECT_LEDGER.getByName(SPEND_LEDGER);
    await ledger.add({ metric: metric(r.source), amount: micros, period: "day", atMs });
    if (r.repoId) {
      await env.PROJECT_LEDGER.getByName(r.repoId).add({
        metric: "usd-micros",
        amount: micros,
        period: "day",
        atMs,
      });
    }
  } catch (e) {
    console.error(JSON.stringify({ spend: { lost: true, source: r.source, usd } }), e);
  }
}

export interface DaySpend {
  day: string;
  totalUsd: number;
  bySource: Record<SpendSource, number>;
}

/** The platform's spend so far on the UTC day of `atMs`. */
export async function spendOn(env: SpendEnv, atMs: number): Promise<DaySpend> {
  const counters = await env.PROJECT_LEDGER.getByName(SPEND_LEDGER).counters({
    metrics: SPEND_SOURCES.map((s) => ({ metric: metric(s), period: "day" as const })),
    atMs,
  });
  const bySource = Object.fromEntries(
    SPEND_SOURCES.map((s) => [s, (counters[metric(s)] ?? 0) / 1e6]),
  ) as Record<SpendSource, number>;
  const totalUsd = Object.values(bySource).reduce((a, b) => a + b, 0);
  return { day: new Date(atMs).toISOString().slice(0, 10), totalUsd, bySource };
}
