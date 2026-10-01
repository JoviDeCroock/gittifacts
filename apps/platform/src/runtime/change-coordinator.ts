/**
 * The platform's `ChangeCoordinator` Durable Object: the coordinator's class, plus one seam between
 * the CI engine and the coordinator's run sink.
 *
 * The engine reports the build artifact as `RunSummary.artifacts.bundle` (`{ key, bytes, sha256,
 * step }`, key `ci-artifacts/<runId>/<step>/bundle.tgz`), while the coordinator's run sink reads
 * `outputs.bundleRef`. Without this mapping every rollout would be skipped as "no bundle". Remove
 * it once the coordinator's `bundleRefOf` reads `artifacts.bundle.key` itself.
 */

import { DEFAULT_BUNDLE_ARTIFACT } from "@app/ci-engine";
import { ChangeCoordinator as CoordinatorDO } from "@app/coordinator/workers";

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** `summary` with `outputs.bundleRef` filled from `artifacts.bundle.key` when the engine set only the latter. */
export function withBundleRef(summary: unknown): unknown {
  const s = record(summary);
  if (s === null) return summary;
  const outputs = record(s.outputs);
  if (typeof outputs?.bundleRef === "string" || typeof s.bundleRef === "string") return summary;
  const key = record(record(s.artifacts)?.[DEFAULT_BUNDLE_ARTIFACT])?.key;
  if (typeof key !== "string" || key === "") return summary;
  return { ...s, outputs: { ...outputs, bundleRef: key } };
}

export class ChangeCoordinator extends CoordinatorDO {
  override onRunFinished(summary: unknown): ReturnType<CoordinatorDO["onRunFinished"]> {
    return super.onRunFinished(withBundleRef(summary));
  }
}
