/**
 * Asking for QA (docs/research/agentic-qa.md §1): one entry point for the Change page, MCP, the CLI
 * and GitHub. Idempotent per head (the run id is derived from the change and head, so two racing
 * requests meet on the same row and workflow instance), rate-limited per repo, and only for a
 * head with a green build. Who may ask is checked by the caller (platform access or GitHub write).
 */
import type { Change } from "@app/domain";
import { drizzle } from "drizzle-orm/d1";
import type { QaRunRow } from "../db/qa-schema.js";
import { ApiError, conflict, notFound } from "../errors.js";
import { D1Store } from "../store/d1-store.js";
import { type QaRunView, QaStore, viewOf } from "./store.js";

export const QA_RATE = { perHour: 6, perDay: 30 } as const;
const CLOSED: ReadonlySet<Change["status"]> = new Set([
  "merged",
  "rolling-out",
  "released",
  "reverted",
  "rejected",
  "abandoned",
]);

export interface QaEnv {
  DB: D1Database;
  BLOBS: R2Bucket;
  QA_WORKFLOW: { create(opts: { id: string; params: unknown }): Promise<unknown> };
}

export interface QaRequest {
  changeId: string;
  principalId: string;
  trigger: QaRunRow["trigger"];
  /** GitHub login that asked (GitHub triggers). */
  login?: string;
  /** Run again even though this head already has a finished run. */
  force?: boolean;
}

export interface QaRequestResult {
  run: QaRunView;
  /** The head already had a run (queued, running or finished): nothing new was started. */
  reused: boolean;
}

export class QaRateLimited extends ApiError {
  constructor(
    readonly retryAfterSec: number,
    message: string,
  ) {
    super(
      429,
      "rate-limited",
      message,
      { retryAfterSec },
      {
        explanation: `QA runs are limited per repo (${QA_RATE.perHour} an hour, ${QA_RATE.perDay} a day). Ask again in ${retryAfterSec} s.`,
      },
    );
  }
}

/** `qa-<change>-<head10>` for the first run of a head, `-r<n>` for re-runs. */
export function qaRunId(changeId: string, headSha: string, n = 1): string {
  return `qa-${changeId}-${headSha.slice(0, 10)}${n > 1 ? `-r${n}` : ""}`.slice(0, 100);
}

export async function requestQa(
  env: QaEnv,
  req: QaRequest,
  now: () => Date = () => new Date(),
): Promise<QaRequestResult> {
  const store = new D1Store(env.DB, env.BLOBS, now);
  const qa = new QaStore(drizzle(env.DB));
  const change = await store.getChange(req.changeId);
  if (change === null) throw notFound(`change ${req.changeId}`);
  const head = change.headSha;
  if (head === null)
    throw conflict(
      "the change has no pushed head yet: push first, then ask for QA",
      "invalid-state",
    );
  if (CLOSED.has(change.status))
    throw conflict(
      `QA runs before a change lands; ${req.changeId} is ${change.status}`,
      "invalid-state",
    );

  const flying = await qa.inFlight(req.changeId);
  if (flying !== null) return { run: viewOf(flying), reused: true };
  const prior = await qa.forHead(req.changeId, head);
  if (prior !== null && req.force !== true) return { run: viewOf(prior), reused: true };

  const runs = await store.listRuns(req.changeId, head);
  if (!runs.some((r) => r.status === "passed")) {
    const latest = runs[0]?.status ?? "not started";
    throw new ApiError(
      409,
      "invalid-state",
      `QA needs a green build of ${head.slice(0, 12)}; its CI is ${latest}`,
      { headSha: head, ci: latest },
      {
        explanation:
          "QA drives the app built by CI. Wait for CI to pass (wait_for_change evidence_ready), then ask again.",
        call: `wait_for_change({ changeId: "${req.changeId}", until: "evidence_ready" })`,
      },
    );
  }

  const at = now();
  const day = await qa.repoSince(change.repoId, new Date(at.getTime() - 86_400_000).toISOString());
  const hour = day.filter((r) => r.createdAt >= new Date(at.getTime() - 3_600_000).toISOString());
  const wait = (from: string | undefined, windowMs: number) =>
    Math.max(
      1,
      Math.ceil(
        ((from === undefined ? at.getTime() : Date.parse(from)) + windowMs - at.getTime()) / 1000,
      ),
    );
  if (day.length >= QA_RATE.perDay)
    throw new QaRateLimited(
      wait(day[0]?.createdAt, 86_400_000),
      `this repo had ${day.length} QA runs in the last day`,
    );
  if (hour.length >= QA_RATE.perHour)
    throw new QaRateLimited(
      wait(hour[0]?.createdAt, 3_600_000),
      `this repo had ${hour.length} QA runs in the last hour`,
    );

  const n =
    prior === null
      ? 1
      : (await qa.forChange(req.changeId, 100)).filter((r) => r.headSha === head).length + 1;
  const id = qaRunId(req.changeId, head, n);
  try {
    await qa.insert({
      id,
      changeId: req.changeId,
      repoId: change.repoId,
      headSha: head,
      status: "queued",
      trigger: req.trigger,
      requestedBy: req.principalId,
      requestedLogin: req.login ?? null,
      progress: "queued",
      createdAt: at.toISOString(),
    });
  } catch (e) {
    // A racing request inserted the same id first: that run is the answer.
    const raced = await qa.get(id);
    if (raced !== null) return { run: viewOf(raced), reused: true };
    throw e;
  }
  try {
    await env.QA_WORKFLOW.create({ id, params: { runId: id } });
  } catch (e) {
    await qa.update(id, {
      status: "failed",
      error: `could not start: ${(e as Error).message}`.slice(0, 2000),
      finishedAt: now().toISOString(),
    });
    throw new ApiError(502, "upstream", "the QA run could not be started; try again", {
      runId: id,
    });
  }
  const row = await qa.get(id);
  if (row === null) throw new Error("qa run disappeared");
  return { run: viewOf(row), reused: false };
}
