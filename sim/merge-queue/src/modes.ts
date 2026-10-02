/**
 * Queue configurations the simulator compares. `full` is the real queue; `serial` and `batch-all`
 * are the §6 baselines; the `no-*` ablations switch off one mechanism each to show what it earns.
 */
import { batchAllConfig, type QueueConfig, queueConfig, serialConfig } from "@app/merge-queue";

export const MODES: Record<string, { label: string; config: () => QueueConfig }> = {
  full: { label: "agent-native queue (all mechanisms)", config: () => queueConfig() },
  serial: { label: "baseline: strictly serial (coordinator's queue)", config: serialConfig },
  "batch-all": { label: "baseline: batch everything, no conflict graph", config: batchAllConfig },
  "no-speculation": {
    label: "no speculation (1 batch in flight per track)",
    config: () => queueConfig({ maxSpeculationDepth: 1 }),
  },
  "no-bisection": {
    label: "no bisection (re-test each unit alone)",
    config: () => queueConfig({ features: { bisection: false } }),
  },
  "no-flake-recheck": {
    label: "no flake re-check",
    config: () => queueConfig({ features: { flakeRecheck: false } }),
  },
  "no-resolver": {
    label: "no conflict resolver (eject conflicts)",
    config: () => queueConfig({ features: { resolver: false } }),
  },
  "no-revalidation": {
    label: "no impacted-target revalidation (stale tracks re-run in full)",
    config: () => queueConfig({ features: { revalidation: false } }),
  },
  "no-fairness": {
    label: "no fair queuing / in-flight cap",
    config: () => queueConfig({ features: { fairness: false } }),
  },
  "no-direct-carry": {
    label: "tip-built speculation (a failure restarts every tree above it)",
    config: () => queueConfig({ features: { directCarry: false } }),
  },
  "no-early-landing": {
    label: "revalidation starts only after the full run passed",
    config: () => queueConfig({ features: { earlyLanding: false } }),
  },
  "no-result-cache": {
    label: "no tree-keyed result cache",
    config: () => queueConfig({ features: { resultCache: false } }),
  },
};

export function modeConfig(name: string): QueueConfig {
  const m = MODES[name];
  if (m === undefined)
    throw new Error(`unknown mode ${name}; known: ${Object.keys(MODES).join(", ")}`);
  return m.config();
}
