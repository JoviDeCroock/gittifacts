/**
 * `Telemetry` on the Workers Observability telemetry query API (release-observability.md §3a):
 * count invocations grouped by `$workers.scriptVersion.id` × `$workers.outcome`, plus a second
 * count of 5xx responses with outcome `ok`. Error rate = (non-ok + ok-5xx) / all. New Workers
 * Issues come from the Store (webhooks land there first); `issueOccurrence` names the version of
 * an issue the webhook reported (its payload has the Worker but no version).
 */
import { z } from "zod";
import type { Clock, IssueOccurrence, Store, Telemetry } from "../ports.js";
import { type CfApiOptions, cfRequest } from "./cf-api.js";

export interface ObservabilityTelemetryOptions extends CfApiOptions {
  store: Pick<Store, "listIssues">;
  clock: Clock;
}

const Aggregates = z
  .object({
    calculations: z
      .array(
        z
          .object({
            aggregates: z
              .array(
                z
                  .object({
                    count: z.number().optional(),
                    value: z.number().optional(),
                    groups: z
                      .array(
                        z.object({
                          key: z.string(),
                          value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
                        }),
                      )
                      .optional(),
                  })
                  .passthrough(),
              )
              .default([]),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const VERSION_KEY = "$workers.scriptVersion.id";
const OUTCOME_KEY = "$workers.outcome";

/**
 * One aggregate query over the script, grouped by version (× outcome). Versions are not filtered
 * with `in` (its value shape is undocumented); the caller picks the two versions it needs from the
 * groups, and a script has only a handful of versions live in a rollout window.
 */
export function telemetryQuery(input: {
  queryId: string;
  script: string;
  from: number;
  to: number;
  serverErrorsOnly: boolean;
}): Record<string, unknown> {
  const filters: Array<Record<string, unknown>> = [
    { key: "$workers.scriptName", operation: "eq", type: "string", value: input.script },
  ];
  if (input.serverErrorsOnly) {
    filters.push({ key: OUTCOME_KEY, operation: "eq", type: "string", value: "ok" });
    filters.push({
      key: "$workers.event.response.status",
      operation: "gte",
      type: "number",
      value: 500,
    });
  }
  return {
    queryId: input.queryId,
    dry: true,
    timeframe: { from: input.from, to: input.to },
    view: "calculations",
    chartType: "aggregate",
    parameters: {
      filters,
      calculations: [{ operator: "count", alias: "n" }],
      groupBys: [
        { type: "string", value: VERSION_KEY },
        ...(input.serverErrorsOnly ? [] : [{ type: "string", value: OUTCOME_KEY }]),
      ],
      limit: 100,
    },
  };
}

/** One occurrence of a Workers Issue (live 2026-10-02: `worker.scriptVersion.id`, `error.stack`). */
const Occurrence = z
  .object({
    timestamp: z.union([z.number(), z.string()]).optional(),
    error: z.object({ stack: z.string().optional() }).passthrough().optional(),
    worker: z
      .object({
        scriptName: z.string().optional(),
        scriptVersion: z.object({ id: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const Occurrences = z.union([
  z.array(Occurrence),
  z.object({ occurrences: z.array(Occurrence) }).transform((o) => o.occurrences),
]);

export function occurrenceOf(o: z.infer<typeof Occurrence>): IssueOccurrence {
  const ts = typeof o.timestamp === "string" ? Number(o.timestamp) : o.timestamp;
  return {
    scriptName: o.worker?.scriptName ?? null,
    versionId: o.worker?.scriptVersion?.id ?? null,
    stack: o.error?.stack ?? null,
    at: ts === undefined || !Number.isFinite(ts) ? null : new Date(ts).toISOString(),
  };
}

interface Tally {
  total: number;
  errors: number;
}

export class ObservabilityTelemetry implements Telemetry {
  constructor(private readonly opts: ObservabilityTelemetryOptions) {}

  private async query(body: Record<string, unknown>): Promise<z.infer<typeof Aggregates>> {
    return cfRequest(
      this.opts,
      { method: "POST", path: "/workers/observability/telemetry/query", json: body },
      Aggregates,
    );
  }

  /** Occurrences are listed newest first; one is enough to name the version. */
  async issueOccurrence(issueId: string): Promise<IssueOccurrence | null> {
    const list = await cfRequest(
      this.opts,
      {
        method: "GET",
        path: `/workers/observability/issues/${encodeURIComponent(issueId)}/occurrences`,
        query: { per_page: "5" },
      },
      Occurrences,
    );
    const newest = list[0];
    return newest === undefined ? null : occurrenceOf(newest);
  }

  async check(input: {
    script: string;
    versionId: string;
    baselineVersionId: string | null;
    since: string;
  }) {
    const to = this.opts.clock.now().getTime();
    const from = Math.min(Date.parse(input.since), to - 60_000);
    const base = { script: input.script, from, to };
    const [byOutcome, serverErrors] = await Promise.all([
      this.query(
        telemetryQuery({
          ...base,
          queryId: `gittifacts-${input.versionId}-outcomes`,
          serverErrorsOnly: false,
        }),
      ),
      this.query(
        telemetryQuery({
          ...base,
          queryId: `gittifacts-${input.versionId}-5xx`,
          serverErrorsOnly: true,
        }),
      ),
    ]);
    const tallies = new Map<string, Tally>();
    const tally = (v: string) => {
      const t = tallies.get(v) ?? { total: 0, errors: 0 };
      tallies.set(v, t);
      return t;
    };
    for (const agg of byOutcome.calculations[0]?.aggregates ?? []) {
      const groups = new Map((agg.groups ?? []).map((g) => [g.key, g.value] as const));
      const version = String(groups.get(VERSION_KEY) ?? "");
      if (version === "") continue;
      const n = agg.count ?? agg.value ?? 0;
      const t = tally(version);
      t.total += n;
      if (groups.get(OUTCOME_KEY) !== "ok") t.errors += n;
    }
    for (const agg of serverErrors.calculations[0]?.aggregates ?? []) {
      const version = String((agg.groups ?? []).find((g) => g.key === VERSION_KEY)?.value ?? "");
      if (version !== "") tally(version).errors += agg.count ?? agg.value ?? 0;
    }
    const rate = (t: Tally | undefined) =>
      t === undefined || t.total === 0 ? null : Math.min(1, t.errors / t.total);
    const mine = tallies.get(input.versionId);
    const baseline =
      input.baselineVersionId === null ? undefined : tallies.get(input.baselineVersionId);
    const issues = await this.opts.store.listIssues({
      versionId: input.versionId,
      since: input.since,
    });
    const newIssueGroups = issues.filter(
      (i) => i.versionId === input.versionId && i.firstSeen >= input.since,
    ).length;
    return {
      requests: mine?.total ?? 0,
      errorRate: rate(mine),
      baselineErrorRate: rate(baseline),
      newIssueGroups,
      issues,
    };
  }
}
