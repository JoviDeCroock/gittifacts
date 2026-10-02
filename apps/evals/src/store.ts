/**
 * Where results live: R2 (`gittifacts-blobs`, EU) under `evals/onboarding/`, one JSON document per
 * run, plus the matrix plan, the matrix-wide safety sweep (written last: a matrix with a sweep is
 * complete) and a summary. Transcripts are kept next to the results for debugging. Each run also
 * writes one Analytics Engine data point (dataset `gittifacts_evals`) for dashboards:
 *
 *   indexes [`<task>:<model>`]
 *   blobs   [matrixId, runId, task, model, provider, stop, "pass"|"fail", first failed check, top error code]
 *   doubles [success 0/1, tool calls, wall ms, tool errors, ttfg ms (-1 = none), tokens, neurons, violations]
 */
import { z } from "zod";
import type { TranscriptEntry } from "./agent/loop.js";
import { MatrixSpec, type MatrixView, RunResult, SafetySweep } from "./results.js";

export const PREFIX = "evals/onboarding";
const MATRICES = `${PREFIX}/matrices/`;

export const keys = {
  matrix: (m: string) => `${MATRICES}${m}/matrix.json`,
  run: (m: string, r: string) => `${MATRICES}${m}/runs/${r}.json`,
  runs: (m: string) => `${MATRICES}${m}/runs/`,
  transcript: (m: string, r: string) => `${MATRICES}${m}/transcripts/${r}.json`,
  sweep: (m: string) => `${MATRICES}${m}/sweep.json`,
  summary: (m: string) => `${MATRICES}${m}/summary.json`,
};

/** Run ids are `<matrixId>--<task>--<model>--r<n>` (valid Workflow instance ids). */
export function runIdFor(matrixId: string, task: string, model: string, attempt: number): string {
  return `${matrixId}--${task}--${model}--r${attempt}`;
}

export function matrixIdOf(runId: string): string | null {
  const i = runId.indexOf("--");
  return i > 0 ? runId.slice(0, i) : null;
}

/** `m-YYYYMMDD-HHMMSS-xxxx`: sorts by start time. */
export function newMatrixId(nowMs: number, rand: () => number = Math.random): string {
  const d = new Date(nowMs).toISOString();
  const stamp = `${d.slice(0, 10).replaceAll("-", "")}-${d.slice(11, 19).replaceAll(":", "")}`;
  const suffix = Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `m-${stamp}-${suffix}`;
}

export const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

export class ResultStore {
  constructor(private readonly bucket: R2Bucket) {}

  private async getJson<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return schema.parse(await obj.json());
  }

  private async putJson(key: string, value: unknown): Promise<void> {
    await this.bucket.put(key, JSON.stringify(value), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  putMatrix(m: MatrixSpec) {
    return this.putJson(keys.matrix(m.matrixId), m);
  }
  getMatrix(id: string) {
    return this.getJson(keys.matrix(id), MatrixSpec);
  }
  putRun(r: RunResult) {
    return this.putJson(keys.run(r.matrixId, r.runId), r);
  }
  async getRun(runId: string): Promise<RunResult | null> {
    const m = matrixIdOf(runId);
    return m ? this.getJson(keys.run(m, runId), RunResult) : null;
  }
  putTranscript(matrixId: string, runId: string, t: TranscriptEntry[]) {
    return this.putJson(keys.transcript(matrixId, runId), t);
  }
  async getTranscript(runId: string): Promise<unknown | null> {
    const m = matrixIdOf(runId);
    return m ? this.getJson(keys.transcript(m, runId), z.unknown()) : null;
  }
  putSweep(matrixId: string, s: SafetySweep) {
    return this.putJson(keys.sweep(matrixId), s);
  }
  getSweep(matrixId: string) {
    return this.getJson(keys.sweep(matrixId), SafetySweep);
  }
  putSummary(matrixId: string, summary: unknown) {
    return this.putJson(keys.summary(matrixId), summary);
  }

  /** Run ids with a recorded result in a matrix. */
  async reportedRunIds(matrixId: string): Promise<Set<string>> {
    const out = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({
        prefix: keys.runs(matrixId),
        ...(cursor ? { cursor } : {}),
      });
      for (const o of page.objects)
        out.add(o.key.slice(keys.runs(matrixId).length, -".json".length));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  async listRuns(matrixId: string): Promise<RunResult[]> {
    const ids = [...(await this.reportedRunIds(matrixId))].sort();
    const runs = await Promise.all(
      ids.map((id) => this.getJson(keys.run(matrixId, id), RunResult)),
    );
    return runs.filter((r): r is RunResult => r !== null);
  }

  /** Matrix ids, newest first. */
  async matrixIds(limit = 50): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({
        prefix: MATRICES,
        delimiter: "/",
        ...(cursor ? { cursor } : {}),
      });
      for (const p of page.delimitedPrefixes) ids.push(p.slice(MATRICES.length, -1));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return ids.sort().reverse().slice(0, limit);
  }

  async view(matrixId: string): Promise<MatrixView | null> {
    const matrix = await this.getMatrix(matrixId);
    if (!matrix) return null;
    const [runs, sweep] = await Promise.all([this.listRuns(matrixId), this.getSweep(matrixId)]);
    return { matrix, runs, sweep, complete: sweep !== null };
  }

  /** The newest matrix (only complete ones with `complete`). */
  async latest(opts: {
    complete: boolean;
    trigger?: "cron" | "manual";
  }): Promise<MatrixView | null> {
    for (const id of await this.matrixIds()) {
      const v = await this.view(id);
      if (!v) continue;
      if (opts.trigger && v.matrix.trigger !== opts.trigger) continue;
      if (!opts.complete || v.complete) return v;
    }
    return null;
  }
}

export function writeRunPoint(ds: AnalyticsEngineDataset | undefined, r: RunResult): void {
  if (!ds) return;
  ds.writeDataPoint({
    indexes: [`${r.task}:${r.modelShort}`],
    blobs: [
      r.matrixId,
      r.runId,
      r.task,
      r.modelShort,
      r.provider,
      r.stop,
      r.success ? "pass" : "fail",
      r.checks.find((c) => !c.pass)?.name ?? "",
      r.errors.codes[0] ?? "",
    ],
    doubles: [
      r.success ? 1 : 0,
      r.toolCalls,
      r.wallMs,
      r.errors.tool,
      r.ttfgMs ?? -1,
      r.tokens.prompt + r.tokens.completion,
      r.neurons,
      r.safety.violations.length,
    ],
  });
}
