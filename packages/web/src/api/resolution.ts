/**
 * `GET /api/v1/changes/:id/resolution`: the merge queue's conflict resolution of a Change (what
 * lands instead of the pushed head). Validated at this boundary like tours and evidence: a
 * malformed resolution fails loudly instead of showing a half-read diff as approved.
 */
import type { ConflictResolution } from "@app/evidence";
import { z } from "zod";
import { ApiError, request } from "./client.js";

export interface ResolutionView {
  /** The resolved head: what lands on main. */
  headSha: string;
  /** The head the author pushed (what an earlier approval covered). */
  originalHeadSha: string | null;
  resolvedFrom: string | null;
  ontoSha: string | null;
  at: string;
  attempt: number;
  kind: "textual" | "semantic";
  item: ConflictResolution | null;
  upstream: { changeId: string; title: string | null; sha: string | null }[];
  tourId: string | null;
  /** The resolution invalidated the approval: a person must approve what lands. */
  approvalRequested: boolean;
  lane: 0 | 1 | 2 | null;
  reasons: string[];
}

async function schema() {
  const { ConflictResolution } = await import("@app/evidence");
  return z.object({
    headSha: z.string(),
    originalHeadSha: z.string().nullable(),
    resolvedFrom: z.string().nullable(),
    ontoSha: z.string().nullable(),
    at: z.string(),
    attempt: z.number(),
    kind: z.enum(["textual", "semantic"]),
    item: ConflictResolution.nullable(),
    upstream: z.array(
      z.object({ changeId: z.string(), title: z.string().nullable(), sha: z.string().nullable() }),
    ),
    tourId: z.string().nullable(),
    approvalRequested: z.boolean(),
    lane: z.union([z.literal(0), z.literal(1), z.literal(2)]).nullable(),
    reasons: z.array(z.string()),
  });
}

export async function parseResolution(value: unknown): Promise<ResolutionView | null> {
  if (value === null) return null;
  const result = (await schema()).safeParse(value);
  if (!result.success)
    throw new ApiError(
      502,
      "invalid_response",
      "The conflict resolution from the server did not match the expected shape.",
      result.error.issues,
    );
  return result.data;
}

/** The resolution, or null when the queue never needed one (or the server predates the route). */
export async function fetchResolution(changeId: string): Promise<ResolutionView | null> {
  try {
    const res = await request<{ resolution: unknown }>(
      "GET",
      `/api/v1/changes/${encodeURIComponent(changeId)}/resolution`,
    );
    return parseResolution(res.resolution);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** The resolved head is what the tour describes: not stale, though it differs from the pushed head. */
export function describesResolution(
  tourHead: string | undefined,
  r: ResolutionView | null,
): boolean {
  return r !== null && tourHead === r.headSha;
}
