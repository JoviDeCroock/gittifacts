/**
 * Test Worker: the real `CiRunWorkflow` and `Runner` with their I/O seams replaced by fakes.
 */
import type { RepoReader } from "../../src/cache/tree.js";
import type { CiRunParams, RunSink } from "../../src/engine.js";
import type { RunDurablyOptions } from "../../src/runner/client.js";
import type { ContainerLike } from "../../src/runner/container.js";
import type { RunnerRpc } from "../../src/runner/job.js";
import { Runner } from "../../src/runner/runner-do.js";
import { CiRunWorkflow, type CiWorkflowEnv } from "../../src/workflows/ci-run.js";
import { FAKE_TOKEN, FakeContainer, fakeRepo } from "./fakes.js";

export interface TestEnv extends CiWorkflowEnv {
  CI_RUN_WORKFLOW: Workflow<CiRunParams>;
  RUNNER: DurableObjectNamespace<TestRunner>;
}

export class TestRunner extends Runner<TestEnv> {
  private fake: FakeContainer | null = null;

  protected override container(): ContainerLike {
    this.fake ??= new FakeContainer(this.env.CI_BUCKET, this.ctx.id.name ?? this.ctx.id.toString());
    return this.fake;
  }

  protected override async mintReadToken(): Promise<string> {
    return FAKE_TOKEN;
  }
}

/**
 * Steps named `drop-*` lose every poll of their first attempt ("Network connection lost."), the
 * way a long Runner RPC died in the M5 dogfood: the attempt fails and Workflows retries the step.
 */
const DROP_PREFIX = "drop-";

export class TestCiRunWorkflow extends CiRunWorkflow<TestEnv> {
  protected override runner(runId: string, step: string): RunnerRpc {
    const real = super.runner(runId, step);
    if (!step.startsWith(DROP_PREFIX)) return real;
    const bucket = this.env.CI_BUCKET;
    const marker = `test-drops/${runId}/${step}`;
    return {
      run: (job) => real.run(job),
      plan: (job) => real.plan(job),
      abort: (reason) => real.abort(reason),
      clearAbort: () => real.clearAbort(),
      describe: () => real.describe(),
      start: async (input) => {
        const n = Number((await (await bucket.get(marker))?.text()) ?? "0") + 1;
        await bucket.put(marker, String(n));
        return real.start(input);
      },
      poll: async (jobId, waitMs) => {
        const n = Number((await (await bucket.get(marker))?.text()) ?? "0");
        if (n <= 1) throw new Error("Network connection lost.");
        return real.poll(jobId, waitMs);
      },
    };
  }

  protected override pollOptions(): RunDurablyOptions {
    return { waitMs: 5_000, maxPollFailures: 2, retryDelayMs: () => 10 };
  }

  protected override async withRepo<T>(
    _name: string,
    fn: (repo: RepoReader) => Promise<T>,
  ): Promise<T> {
    return fn(fakeRepo());
  }

  protected override runSink(req: CiRunParams): RunSink {
    return {
      onRunFinished: async (summary) => {
        await this.env.CI_BUCKET.put(
          `test-sink/${req.changeId}/${summary.id}.json`,
          JSON.stringify(summary),
        );
      },
    };
  }
}

export { CiEgressGateway } from "../../src/runner/egress-gateway.js";

export default {
  fetch(): Response {
    return new Response("ci-engine test worker");
  },
};
