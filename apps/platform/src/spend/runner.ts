/**
 * The platform's `Runner` Durable Object: the CI engine's Runner plus spend metering. Every
 * container a Runner drives (CI steps, plan jobs, policy/rebase/revert/queue sandbox jobs, import
 * detection) reports its instance and wall time once it is destroyed; that is priced and recorded
 * as `ci` spend (src/spend/meter.ts).
 */
import { type ContainerTime, Runner as EngineRunner, type RunnerEnv } from "@app/ci-engine";
import { recordSpend, type SpendEnv } from "./meter.js";
import { containerUsd } from "./prices.js";

export class Runner extends EngineRunner<RunnerEnv & SpendEnv> {
  protected override async onContainerTime(usage: ContainerTime): Promise<void> {
    await recordSpend(this.env, {
      source: "ci",
      usd: containerUsd(usage.instance, usage.ms),
      ref: `${usage.runId}:${usage.step} ${usage.instance} ${Math.round(usage.ms / 1000)}s`,
    });
  }
}
