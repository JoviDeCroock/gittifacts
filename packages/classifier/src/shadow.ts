import type { Lane, RepoPolicy } from "@app/domain";

export interface ShadowSample {
  /** What the classifier computed (before shadow mode). */
  computedLane: Lane;
  /** What lane the human reviewer said it deserved, if they said. */
  humanLane: Lane | null;
  decision: "approve" | "request-changes" | "reject";
}

export interface ShadowAgreement {
  /** Number of samples that count: only those the classifier computed as Lane 0. */
  samples: number;
  /** Counted samples the human approved without changes (and, if they gave one, rated Lane 0). */
  agreed: number;
  /** agreed / samples, 0 when there are no samples. */
  ratio: number;
  /** samples >= policy.shadow.minSamples and ratio >= policy.shadow.agreementThreshold. */
  eligibleToEnableLane0: boolean;
  /**
   * How many more Lane-0 candidates, all agreeing, are needed before eligibleToEnableLane0
   * becomes true (0 when already eligible). null when agreement alone can never get there
   * (agreementThreshold is 1 and a disagreement is already on record).
   */
  needed: number | null;
}

/** A Lane-0 candidate "agrees" when the human approved it and did not rate it above Lane 0. */
export function sampleAgrees(sample: ShadowSample): boolean {
  return (
    sample.computedLane === 0 &&
    sample.decision === "approve" &&
    (sample.humanLane === null || sample.humanLane === 0)
  );
}

/**
 * Shadow-mode agreement between the classifier's Lane-0 calls and human reviews. Pure.
 * Only samples with computedLane === 0 count: the question is "would auto-merging these have
 * been fine?", not whether humans agree with Lane 1/2 calls.
 */
export function shadowAgreement(
  samples: readonly ShadowSample[],
  policy: Pick<RepoPolicy, "shadow">,
): ShadowAgreement {
  const { agreementThreshold: threshold, minSamples } = policy.shadow;
  const counted = samples.filter((s) => s.computedLane === 0);
  const n = counted.length;
  const agreed = counted.filter(sampleAgrees).length;
  const eligible = (total: number, ok: number): boolean =>
    total > 0 && total >= minSamples && ok / total >= threshold;

  let needed: number | null = 0;
  if (!eligible(n, agreed)) {
    if (threshold >= 1 && agreed < n) {
      needed = null;
    } else {
      // Smallest k with eligible(n + k, agreed + k). Start from the closed form, then step with
      // the exact predicate so floating-point rounding can never disagree with `eligible`.
      const byRatio = threshold >= 1 ? 0 : Math.ceil((threshold * n - agreed) / (1 - threshold));
      let k = Math.max(0, minSamples - n, byRatio, n === 0 ? 1 : 0);
      while (k > 0 && eligible(n + k - 1, agreed + k - 1)) k--;
      while (!eligible(n + k, agreed + k)) k++;
      needed = k;
    }
  }

  return {
    samples: n,
    agreed,
    ratio: n === 0 ? 0 : agreed / n,
    eligibleToEnableLane0: eligible(n, agreed),
    needed,
  };
}
