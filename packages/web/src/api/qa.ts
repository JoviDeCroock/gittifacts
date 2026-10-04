/**
 * QA in a browser, on request: `GET /api/v1/changes/:id/qa` (the change's runs, newest first) and
 * `POST /api/v1/changes/:id/qa` (ask for one). The report is the signed `qa-run` item, validated
 * at this boundary like evidence (a malformed report fails loudly instead of reading as a pass).
 */
import type { QaRun } from "@app/evidence";
import { z } from "zod";
import { ApiError, request } from "./client.js";

export interface QaRunView {
  id: string;
  changeId: string;
  headSha: string;
  status: "queued" | "running" | "done" | "failed";
  trigger: string;
  requestedLogin: string | null;
  progress: string | null;
  summary: { passed: number; failed: number; couldntTest: number } | null;
  laneBefore: number | null;
  laneAfter: number | null;
  costUsd: number | null;
  wallMs: number | null;
  error: string | null;
  /** Approvals this run withdrew (a failed criterion after approval). */
  withdrawn: Array<{ reviewId: string; reviewerId: string; name: string }>;
  createdAt: string;
  finishedAt: string | null;
  report: QaRun | null;
}

async function schema() {
  const { QaRun } = await import("@app/evidence");
  return z
    .object({
      id: z.string(),
      changeId: z.string(),
      headSha: z.string(),
      status: z.enum(["queued", "running", "done", "failed"]),
      trigger: z.string(),
      requestedLogin: z.string().nullable(),
      progress: z.string().nullable(),
      summary: z
        .object({ passed: z.number(), failed: z.number(), couldntTest: z.number() })
        .nullable(),
      laneBefore: z.number().nullable(),
      laneAfter: z.number().nullable(),
      costUsd: z.number().nullable(),
      wallMs: z.number().nullable(),
      error: z.string().nullable(),
      withdrawn: z
        .array(z.object({ reviewId: z.string(), reviewerId: z.string(), name: z.string() }))
        .default([]),
      createdAt: z.string(),
      finishedAt: z.string().nullable(),
      report: QaRun.nullable(),
    })
    .passthrough();
}

export async function fetchQaRuns(changeId: string): Promise<QaRunView[]> {
  let res: { runs: unknown[] };
  try {
    res = await request<{ runs: unknown[] }>(
      "GET",
      `/api/v1/changes/${encodeURIComponent(changeId)}/qa`,
    );
  } catch (err) {
    // No QA route here (mock mode, an older platform): no runs.
    if (err instanceof ApiError && err.status === 404) return [];
    throw err;
  }
  const s = await schema();
  return res.runs.map((r) => {
    const parsed = s.safeParse(r);
    if (!parsed.success)
      throw new ApiError(
        502,
        "invalid_response",
        "The QA report from the server did not match the expected shape.",
        parsed.error.issues,
      );
    return parsed.data as QaRunView;
  });
}

export function requestQa(
  changeId: string,
  force: boolean,
  key?: string,
): Promise<{ run: QaRunView; reused: boolean }> {
  return request(
    "POST",
    `/api/v1/changes/${encodeURIComponent(changeId)}/qa`,
    force ? { force: true } : {},
    key,
  );
}
