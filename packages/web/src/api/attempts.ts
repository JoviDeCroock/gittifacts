/**
 * Attempts at one plan: several agents attempt the same approved Plan, each its own Change.
 * `GET /api/v1/plans/:planId/attempts` ranks them by evidence and lane (@app/domain `rankAttempts`
 * on the server); `POST /api/v1/plans/:planId/attempts/:changeId/pick` (session humans only)
 * approves one at the head the person saw and closes the other open attempts as superseded.
 * In mock mode the in-browser backend answers the same paths (mock-attempts.ts).
 *
 * The ranking recommends what a person approves, so it is validated like plans and tours: a
 * malformed answer fails loudly instead of rendering a recommendation.
 */
import type { Change, RankedAttempt } from "@app/domain";
import type { AttemptsRanking } from "@app/domain/attempts";
import { ApiError, request } from "./client.js";

export interface PickedAttempt {
  changeId: string;
  by: { id: string; name: string };
  at: string;
}

export type PlanAttemptsView = AttemptsRanking & { planId: string; picked: PickedAttempt | null };

export interface PickResult {
  planId: string;
  picked: PickedAttempt;
  change: Change;
  /** False when the attempt was already approved: the pick only closed the others. */
  approved: boolean;
  superseded: Array<{ changeId: string; title: string; status: string }>;
  notClosed: Array<{ changeId: string; error: string }>;
}

export type { RankedAttempt };

const enc = encodeURIComponent;

/** zod and the domain schema load on first use, keeping them out of the entry chunk. */
async function viewSchema() {
  const [{ z }, { AttemptsRanking: Ranking }] = await Promise.all([
    import("zod"),
    import("@app/domain/attempts"),
  ]);
  const Picked = z.object({
    changeId: z.string(),
    by: z.object({ id: z.string(), name: z.string() }),
    at: z.string(),
  });
  return Ranking.extend({ planId: z.string(), picked: Picked.nullable() });
}

export const attemptsApi = {
  list: async (planId: string): Promise<PlanAttemptsView> => {
    const [raw, schema] = await Promise.all([
      request<unknown>("GET", `/api/v1/plans/${enc(planId)}/attempts`),
      viewSchema(),
    ]);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        502,
        "invalid_response",
        "The attempts from the server did not match the expected shape.",
        parsed.error.issues,
      );
    }
    return parsed.data;
  },
  pick: (
    planId: string,
    changeId: string,
    input: { headSha?: string; comment?: string },
    key?: string,
  ) =>
    request<PickResult>(
      "POST",
      `/api/v1/plans/${enc(planId)}/attempts/${enc(changeId)}/pick`,
      input,
      key,
    ),
};
