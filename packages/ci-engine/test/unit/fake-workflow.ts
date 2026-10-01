import type { InstanceStatusLike } from "../../src/run-store.js";
import type { WorkflowInstanceLike, WorkflowLike } from "../../src/workflows/engine.js";

export class FakeInstance<P> implements WorkflowInstanceLike {
  state: InstanceStatusLike = { status: "queued" };
  readonly restarts: ({ from?: { name: string } } | undefined)[] = [];
  terminated = 0;
  constructor(readonly params: P) {}
  async status(): Promise<InstanceStatusLike> {
    return this.state;
  }
  async terminate(): Promise<void> {
    if (["complete", "errored", "terminated"].includes(this.state.status)) {
      throw new Error("instance.cannot_terminate");
    }
    this.terminated++;
    this.state = { status: "terminated" };
  }
  async restart(options?: { from?: { name: string } }): Promise<void> {
    this.restarts.push(options);
    this.state = { status: "running" };
  }
}

export class FakeWorkflow<P = unknown> implements WorkflowLike<P> {
  readonly instances = new Map<string, FakeInstance<P>>();
  creates = 0;
  async create(options: { id: string; params: P }): Promise<FakeInstance<P>> {
    this.creates++;
    if (this.instances.has(options.id)) throw new Error("instance.already_exists");
    const inst = new FakeInstance(options.params);
    this.instances.set(options.id, inst);
    return inst;
  }
  async get(id: string): Promise<FakeInstance<P>> {
    const inst = this.instances.get(id);
    if (inst === undefined) throw new Error("instance.not_found");
    return inst;
  }
}

/** Runner control stubs that record calls; `hang` makes abort never resolve. */
export class FakeRunners {
  readonly aborted: string[] = [];
  readonly cleared: string[] = [];
  hang = false;
  getByName(name: string) {
    return {
      abort: async (_reason: string) => {
        if (this.hang) await new Promise(() => {});
        this.aborted.push(name);
      },
      clearAbort: async () => {
        this.cleared.push(name);
      },
    };
  }
}
