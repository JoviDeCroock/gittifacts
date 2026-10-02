/**
 * Test Worker: the real Worker (routes, cron), `EvalRunWorkflow`, `EvalMatrixWorkflow` and
 * `EvalSandbox`, with their I/O seams replaced: a fake container, a scripted model (script per run
 * from R2 `test-scripts/<runId>.json`) and an in-memory fake platform per Workflow instance.
 */
import type { WorkflowStep } from "cloudflare:workers";
import type { EvalEnv } from "../../src/env.js";
import { type ContainerLike, EvalSandbox } from "../../src/sandbox.js";
import { EvalMatrixWorkflow } from "../../src/workflows/matrix.js";
import type { MatrixDeps } from "../../src/workflows/matrix-core.js";
import { EvalRunWorkflow } from "../../src/workflows/run.js";
import type { RunDeps, RunParams } from "../../src/workflows/run-core.js";
import { FakePlatform, fakePlatformFetch, HOST } from "../fake-platform.js";
import { ScriptedModel, type ScriptedTurn } from "../fakes.js";

export { default } from "../../src/index.js";

export class FakeContainer implements ContainerLike {
  running = false;
  starts = 0;
  destroyed = 0;
  lastStart: unknown = null;
  readonly execs: { cmd: string[]; user?: string; cwd?: string }[] = [];
  readonly images = { base: "registry.test/gittifacts-sandbox:abc" };

  start(options: ContainerStartupOptions): void {
    this.running = true;
    this.starts++;
    this.lastStart = options;
  }

  async setInactivityTimeout(): Promise<void> {}

  async exec(cmd: string[], opts?: ContainerExecOptions) {
    this.execs.push({
      cmd,
      ...(opts?.user ? { user: opts.user } : {}),
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    });
    const script = cmd[2] ?? "";
    const text = cmd[0] === "true" ? "" : `ran: ${script}\n`;
    const exit = /exit 3/.test(script) ? 3 : 0;
    return {
      stdout: new Response(text).body,
      exitCode: Promise.resolve(exit),
    };
  }

  async destroy(): Promise<void> {
    this.running = false;
    this.destroyed++;
  }
}

export class TestEvalSandbox extends EvalSandbox<EvalEnv> {
  private fake: FakeContainer | null = null;

  protected override container(): ContainerLike {
    this.fake ??= new FakeContainer();
    return this.fake;
  }

  /** Test-only RPC: what the fake container saw. */
  async inspect() {
    const f = this.fake;
    return {
      starts: f?.starts ?? 0,
      running: f?.running ?? false,
      destroyed: f?.destroyed ?? 0,
      /** JSON of the last ContainerStartupOptions. */
      lastStart: JSON.stringify(f?.lastStart ?? null),
      execs: f?.execs.map((e) => ({ ...e })) ?? [],
    };
  }
}

const DEFAULT_SCRIPT: ScriptedTurn[] = [
  { call: "http_fetch", args: { url: `${HOST}/start` } },
  {
    call: "http_fetch",
    args: { url: `${HOST}/api/v1/projects`, method: "POST", body: { template: "workers-api" } },
  },
  { final: "Deployed." },
];

export class TestEvalRunWorkflow extends EvalRunWorkflow {
  protected override async deps(params: RunParams, step: WorkflowStep): Promise<RunDeps> {
    const base = await super.deps(params, step);
    const platform = new FakePlatform();
    platform.autoGreen = true;
    const stored = await this.env.RESULTS.get(`test-scripts/${params.runId}.json`);
    const script = stored ? ((await stored.json()) as ScriptedTurn[]) : DEFAULT_SCRIPT;
    const f = fakePlatformFetch(platform);
    return {
      ...base,
      cfg: { ...base.cfg, checkGraceMs: 0 },
      model: new ScriptedModel(script),
      fetcher: f,
      adminFetcher: f,
      sleep: async () => {},
    };
  }
}

export class TestEvalMatrixWorkflow extends EvalMatrixWorkflow {
  protected override deps(step: WorkflowStep): MatrixDeps {
    const f = fakePlatformFetch(new FakePlatform());
    return { ...super.deps(step), fetcher: f, adminFetcher: f };
  }
}
