/**
 * Test Worker: the real `CiRunWorkflow` and `Runner` with their I/O seams replaced by fakes.
 */
import type { RepoReader } from "../../src/cache/tree.js";
import type { CiRunParams, RunSink } from "../../src/engine.js";
import type { ContainerLike } from "../../src/runner/container.js";
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

export class TestCiRunWorkflow extends CiRunWorkflow<TestEnv> {
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

export default {
  fetch(): Response {
    return new Response("ci-engine test worker");
  },
};
