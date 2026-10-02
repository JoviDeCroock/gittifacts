import type { RunMetrics } from "./sim.js";
import type { Workload } from "./workload.js";

const f1 = (x: number) => x.toFixed(1);
const pct = (x: number) => `${(100 * x).toFixed(2)}%`;

export function formatRun(m: RunMetrics, w?: Workload): string {
  const lines = [
    `== ${m.scenario} / ${m.mode} / seed ${m.seed}${w ? ` (K=${w.clusters} clusters, measured conflict density ${pct(w.measuredDensity)})` : ""}`,
    `arrivals ${m.arrivals}  merged ${m.merged}  ejected ${m.ejected}  unfinished ${m.unfinished}  backlog@end-of-arrivals ${m.backlogAtArrivalEnd}  sim ${f1(m.simHours)}h`,
    `throughput ${f1(m.throughputPerHour)}/h  time-in-queue p50 ${f1(m.timeInQueueMin.p50)}m p95 ${f1(m.timeInQueueMin.p95)}m p99 ${f1(m.timeInQueueMin.p99)}m  (others p95 ${f1(m.timeInQueueOthersP95Min)}m)`,
    `phases: to-batch p50 ${f1(m.phasesMin.toBatchP50)}m p95 ${f1(m.phasesMin.toBatchP95)}m, batch-to-merge p50 ${f1(m.phasesMin.batchToMergeP50)}m p95 ${f1(m.phasesMin.batchToMergeP95)}m, passed-to-merge p50 ${f1(m.phasesMin.passedToMergeP50)}m p95 ${f1(m.phasesMin.passedToMergeP95)}m`,
    `CI ${f1(m.ciMinutes)} min = ${f1(m.ciMinutesPerMerged)}/merged = ${m.ciRatio.toFixed(2)}x isolated (${Object.entries(
      m.ciMinutesByKind,
    )
      .map(([k, v]) => `${k} ${f1(v)}`)
      .join(", ")})`,
    `eject ${pct(m.ejectRate)}  false-eject ${pct(m.falseEjectRate)}  codes ${JSON.stringify(m.ejectCodes)}`,
    `resolver textual ${m.resolver.textual.resolved}/${m.resolver.textual.incidents} semantic ${m.resolver.semantic.resolved}/${m.resolver.semantic.incidents}  lane downgrades ignored ${m.resolver.laneDowngradesIgnored}, lane decreases ${m.resolver.laneDecreases}`,
    `main-red ${m.mainRedEvents}  masked ${m.maskedByQuarantine}  attribution failures ${m.attributionFailures}/${m.regressions} regressions  flag kills ${m.flagKills} rollbacks ${m.rollbacks} reverts ${m.reverts} freezes ${m.freezes} (${f1(m.frozenMinutes)}m)`,
    `batches ${m.batches} avg size ${m.avgBatchSize.toFixed(2)}  probes ${m.probes} landings ${m.landings} fallbacks ${m.fallbacks} quarantines ${m.quarantines}  max queue ${m.maxQueueLength}  brier ${m.predictionBrier?.toFixed(4) ?? "-"} (${m.predictions})`,
    `refs leaked ${m.refsLeaked}  violations ${m.invariantViolations.length}${m.invariantViolations.length ? `: ${m.invariantViolations.slice(0, 3).join(" | ")}` : ""}  steps ${m.steps}  wall ${(m.wallMs / 1000).toFixed(1)}s`,
  ];
  return lines.join("\n");
}
