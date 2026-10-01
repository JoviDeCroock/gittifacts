/**
 * Time-to-first-green (docs/prompts/02-onboarding.md §1): how long from `create_project` to a
 * green first CI run and a serving preview. Every project gets a D1 row (`project_onboarding`) and
 * Analytics Engine data points in METRICS:
 *
 *   indexes: [projectId]
 *   blobs:   [projectId, template, outcome, "ttfg"]            (blob4 names the metric)
 *   doubles: [msToGreen, msToPreview, msToRespond]
 *
 * written once at creation (outcome "created") and once when the bootstrap Change has sealed its
 * evidence (outcome green | ci-failed | preview-failed | no-preview). The dashboard reads the
 * Analytics Engine SQL API when CF_API_TOKEN can, and the D1 rows otherwise.
 */
import {
  changeWorkflowId,
  ciRunIdFor,
  type Onboarding,
  type PreviewOutcome,
} from "@app/coordinator";
import { desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { projectOnboarding } from "../db/schema.js";
import type { D1Store } from "../store/d1-store.js";

export const TTFG_METRIC = "ttfg";
export const TTFG_TARGET_MS = 60_000;

export type TtfgOutcome = "created" | "green" | "ci-failed" | "preview-failed" | "no-preview";

export interface MetricsEnv {
  METRICS?: Pick<AnalyticsEngineDataset, "writeDataPoint">;
}

function ms(from: string, to: string | null | undefined): number | null {
  if (to === null || to === undefined) return null;
  const d = Date.parse(to) - Date.parse(from);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

export function outcomeOf(ciStatus: string, preview: PreviewOutcome | null): TtfgOutcome {
  if (ciStatus !== "passed") return "ci-failed";
  if (preview === null || preview.status === "skipped") return "no-preview";
  return preview.status === "ready" ? "green" : "preview-failed";
}

function writePoint(
  env: MetricsEnv,
  p: {
    projectId: string;
    template: string | null;
    outcome: TtfgOutcome;
    msToGreen: number | null;
    msToPreview: number | null;
    msToRespond: number | null;
  },
): void {
  try {
    env.METRICS?.writeDataPoint({
      indexes: [p.projectId],
      blobs: [p.projectId, p.template ?? "none", p.outcome, TTFG_METRIC],
      doubles: [p.msToGreen ?? -1, p.msToPreview ?? -1, p.msToRespond ?? -1],
    });
  } catch {
    // Metrics never fail the request.
  }
}

/** create_project responded: the row the bootstrap's completion fills in. */
export async function recordProjectCreated(
  store: D1Store,
  env: MetricsEnv,
  input: {
    projectId: string;
    template: string | null;
    source: "template" | "import" | "empty";
    principalId: string;
    bootstrapChangeId: string | null;
    createdAt: Date;
    respondedAt: Date;
  },
): Promise<void> {
  const createdAt = input.createdAt.toISOString();
  const respondedAt = input.respondedAt.toISOString();
  const msToRespond = ms(createdAt, respondedAt);
  await store.db
    .insert(projectOnboarding)
    .values({
      projectId: input.projectId,
      template: input.template,
      source: input.source,
      principalId: input.principalId,
      bootstrapChangeId: input.bootstrapChangeId,
      createdAt,
      respondedAt,
      msToRespond,
    })
    // A retried create_project (same idempotency key) keeps the first request's clock.
    .onConflictDoNothing();
  writePoint(env, {
    projectId: input.projectId,
    template: input.template,
    outcome: "created",
    msToGreen: null,
    msToPreview: null,
    msToRespond,
  });
}

/** The coordinator's Onboarding port: the bootstrap Change sealed its evidence. */
export class OnboardingMetrics implements Onboarding {
  constructor(
    private readonly store: D1Store,
    private readonly env: MetricsEnv,
  ) {}

  async bootstrapReady(input: Parameters<Onboarding["bootstrapReady"]>[0]): Promise<void> {
    const row = await this.store.db
      .select()
      .from(projectOnboarding)
      .where(eq(projectOnboarding.projectId, input.repoId))
      .get();
    if (row === undefined) return; // not created through create_project
    const change = await this.store.getChange(input.changeId);
    const run =
      change?.headSha == null
        ? null
        : await this.store.getRun(ciRunIdFor(changeWorkflowId(change.id, change.headSha)));
    const outcome = outcomeOf(input.ciStatus, input.preview);
    const ciGreenAt = run?.finishedAt ?? input.evidenceAt;
    const previewReadyAt = input.preview?.status === "ready" ? input.evidenceAt : null;
    const msToGreen = ms(row.createdAt, ciGreenAt);
    const msToPreview = ms(row.createdAt, previewReadyAt);
    await this.store.db
      .update(projectOnboarding)
      .set({
        evidenceAt: input.evidenceAt,
        previewReadyAt,
        ciStatus: input.ciStatus,
        previewStatus: input.preview?.status ?? null,
        outcome,
        msToGreen,
        msToPreview,
      })
      .where(eq(projectOnboarding.projectId, input.repoId));
    writePoint(this.env, {
      projectId: input.repoId,
      template: row.template,
      outcome,
      msToGreen,
      msToPreview,
      msToRespond: row.msToRespond,
    });
  }
}

// ---------------------------------------------------------------- dashboard

export const TtfgProject = z.object({
  projectId: z.string(),
  template: z.string().nullable(),
  outcome: z.string().nullable(),
  createdAt: z.string(),
  msToRespond: z.number().nullable(),
  msToGreen: z.number().nullable(),
  msToPreview: z.number().nullable(),
});
export type TtfgProject = z.infer<typeof TtfgProject>;

export interface TtfgStats {
  projects: number;
  finished: number;
  green: number;
  /** First green (CI green and preview serving) within the 60 s target. */
  withinTarget: number;
  p50Ms: number | null;
  p90Ms: number | null;
}

export interface TtfgReport {
  source: "analytics-engine" | "d1";
  sinceDays: number;
  targetMs: number;
  overall: TtfgStats;
  byTemplate: Array<{ template: string } & TtfgStats>;
  recent: TtfgProject[];
  note: string | null;
}

/** Time-to-first-green of a project: CI green and the preview serving (the later of the two). */
export function firstGreenMs(p: TtfgProject): number | null {
  if (p.outcome !== "green" || p.msToGreen === null || p.msToPreview === null) return null;
  return Math.max(p.msToGreen, p.msToPreview);
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] ?? null;
}

export function ttfgStats(rows: readonly TtfgProject[]): TtfgStats {
  const finished = rows.filter((r) => r.outcome !== null && r.outcome !== "created");
  const greens = finished
    .map(firstGreenMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  return {
    projects: rows.length,
    finished: finished.length,
    green: greens.length,
    withinTarget: greens.filter((v) => v <= TTFG_TARGET_MS).length,
    p50Ms: quantile(greens, 0.5),
    p90Ms: quantile(greens, 0.9),
  };
}

export function ttfgReport(
  rows: readonly TtfgProject[],
  source: TtfgReport["source"],
  sinceDays: number,
  note: string | null,
): TtfgReport {
  const templates = [...new Set(rows.map((r) => r.template ?? "none"))].sort();
  return {
    source,
    sinceDays,
    targetMs: TTFG_TARGET_MS,
    overall: ttfgStats(rows),
    byTemplate: templates.map((template) => ({
      template,
      ...ttfgStats(rows.filter((r) => (r.template ?? "none") === template)),
    })),
    recent: rows.slice(0, 200),
    note,
  };
}

export async function ttfgFromD1(store: D1Store, since: Date): Promise<TtfgProject[]> {
  const rows = await store.db
    .select()
    .from(projectOnboarding)
    .where(gte(projectOnboarding.createdAt, since.toISOString()))
    .orderBy(desc(projectOnboarding.createdAt))
    .limit(1000)
    .all();
  return rows.map((r) => ({
    projectId: r.projectId,
    template: r.template,
    outcome: r.outcome,
    createdAt: r.createdAt,
    msToRespond: r.msToRespond,
    msToGreen: r.msToGreen,
    msToPreview: r.msToPreview,
  }));
}

const AeRow = z.object({
  project_id: z.string(),
  template: z.string(),
  outcome: z.string(),
  ms_to_green: z.coerce.number(),
  ms_to_preview: z.coerce.number(),
  ms_to_respond: z.coerce.number(),
  ts: z.string(),
});

/** Analytics Engine SQL API (needs CF_API_TOKEN with Account Analytics Read). */
export async function ttfgFromAnalyticsEngine(
  opts: { accountId: string; apiToken: string; dataset: string; fetch?: typeof fetch },
  sinceDays: number,
): Promise<TtfgProject[]> {
  const days = Math.max(1, Math.min(90, Math.trunc(sinceDays)));
  if (!/^[A-Za-z0-9_]+$/.test(opts.dataset)) throw new Error("invalid dataset name");
  const query = `SELECT blob1 AS project_id, blob2 AS template, blob3 AS outcome, double1 AS ms_to_green, double2 AS ms_to_preview, double3 AS ms_to_respond, toString(timestamp) AS ts FROM ${opts.dataset} WHERE blob4 = '${TTFG_METRIC}' AND timestamp > NOW() - INTERVAL '${days}' DAY ORDER BY timestamp DESC LIMIT 2000 FORMAT JSON`;
  const res = await (opts.fetch ?? fetch)(
    `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/analytics_engine/sql`,
    { method: "POST", headers: { authorization: `Bearer ${opts.apiToken}` }, body: query },
  );
  if (!res.ok) throw new Error(`Analytics Engine SQL API answered ${res.status}`);
  const body = z.object({ data: z.array(AeRow) }).parse(await res.json());
  // One point at creation, one at first green: fold them per project (newest first).
  const byProject = new Map<string, TtfgProject>();
  for (const r of [...body.data].reverse()) {
    const prev = byProject.get(r.project_id);
    const val = (n: number) => (n < 0 ? null : n);
    byProject.set(r.project_id, {
      projectId: r.project_id,
      template: r.template === "none" ? null : r.template,
      outcome: r.outcome === "created" ? (prev?.outcome ?? null) : r.outcome,
      createdAt: prev?.createdAt ?? r.ts,
      msToRespond: val(r.ms_to_respond) ?? prev?.msToRespond ?? null,
      msToGreen: val(r.ms_to_green) ?? prev?.msToGreen ?? null,
      msToPreview: val(r.ms_to_preview) ?? prev?.msToPreview ?? null,
    });
  }
  return [...byProject.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
