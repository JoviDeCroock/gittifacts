/**
 * A deterministic reviewer for the contract suite. The real reviewer is a model; this one builds
 * the tour from the platform's own hunk ranking (`rankHunks`, the "risk candidate 1" the model's
 * first risk stop must cite), so the tour depends only on what the host fed it: the diff, the
 * evidence, the plan and the lane reasons. Same inputs on every host → the same tour.
 */
import type { GradeReviewer } from "@app/core";
import { rankHunks } from "@app/core/tour";
import type { Tour, TourStop } from "@app/domain";

export function contractReviewer(): GradeReviewer {
  return {
    async judge() {
      // No model judgments: lanes come from measured evidence only.
      return { items: [], costUsd: 0, budgetExceeded: false };
    },
    async tour(input) {
      const ranked = rankHunks({
        diff: input.diff,
        evidence: input.evidence.items,
        plan: input.plan,
        reasons: input.classification.reasons,
      });
      const stops: TourStop[] = [
        {
          kind: "intent",
          title: "What this change does",
          why: input.plan?.intent.slice(0, 1200) ?? "No approved plan is linked.",
          hunkRefs: [],
          evidenceRefs: [],
          verdict: input.plan === null ? "unproven" : "proven",
        },
      ];
      const top = ranked[0];
      if (top !== undefined) {
        const factors = top.factors.map((f) => f.detail).join("; ");
        stops.push({
          kind: "risk",
          title: `Riskiest hunk: ${top.path}`.slice(0, 160),
          why: (factors === "" ? "The largest change." : factors).slice(0, 1200),
          hunkRefs: [top.ref],
          evidenceRefs: [],
          verdict: "risk",
        });
      }
      const headSha = input.change.headSha ?? "";
      const tour: Tour = {
        id: `tour-${input.change.id}-${headSha.slice(0, 8)}`,
        changeId: input.change.id,
        headSha,
        stops,
        leastConfident: ["Contract reviewer: ranking only, no model."],
        notDone: ["Nothing beyond the ranked hunks."],
        generatedBy: {
          principalId: "contract-reviewer",
          model: "rank",
          promptVersion: "contract-1",
          attempts: 1,
          costUsd: 0,
        },
        createdAt: "2026-10-03T00:00:00.000Z",
      };
      return { status: "ok", tour, costUsd: 0, budgetExceeded: false };
    },
  };
}

/** The file the tour's first risk stop points at (the riskiest hunk), or null. */
export function riskiestFile(tour: Tour | null): string | null {
  const stop = tour?.stops.find((s) => s.kind === "risk");
  return stop?.hunkRefs[0]?.file ?? null;
}
