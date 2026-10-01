/**
 * The CI engine's run sink: persist every run update, and deliver terminal runs to the
 * ChangeWorkflow instance that started them as a `ci-finished` event.
 */
import type { RunStatus } from "@app/domain";
import type { CoordinatorBindings } from "./bindings.js";
import { type CiFinishedEvent, EVENT_CI_FINISHED } from "./events.js";
import type { CiRunReport, Ports, RunSink } from "./ports.js";

const TERMINAL: ReadonlySet<RunStatus> = new Set(["passed", "failed", "cancelled", "superseded", "errored"]);

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

export function createRunSink(ports: Pick<Ports, "store">, bindings: CoordinatorBindings): RunSink {
  return {
    async report(report: CiRunReport): Promise<void> {
      await ports.store.upsertRun(report.run);
      if (!isTerminalRun(report.run.status) || report.replyTo === null) return;
      // A superseded run's workflow was terminated: nobody is listening.
      if (report.run.status === "superseded") return;
      const payload: CiFinishedEvent = {
        run: report.run,
        items: report.items,
        outputs: { bundleRef: report.outputs.bundleRef },
      };
      const instance = await bindings.changeWorkflow.get(report.replyTo.instanceId);
      await instance.sendEvent({ type: EVENT_CI_FINISHED, payload });
    },
  };
}
