import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

interface Env {
  RUNNER: DurableObjectNamespace<ProbeDO>;
  PROBE_WF: Workflow<{ x: number }>;
  CI_BUCKET: R2Bucket;
}
export class ProbeDO extends DurableObject<Env> {
  async hello(n: number): Promise<number> {
    await new Promise((r) => setTimeout(r, 20));
    return n * 2;
  }
}
export class ProbeWorkflow extends WorkflowEntrypoint<Env, { x: number }> {
  override async run(event: WorkflowEvent<{ x: number }>, step: WorkflowStep) {
    const [a, b] = await Promise.all([
      step.do("a", () => this.env.RUNNER.getByName("a").hello(event.payload.x)),
      step.do("b", () => this.env.RUNNER.getByName("b").hello(event.payload.x + 1)),
    ]);
    await step.do("put", async () => {
      await this.env.CI_BUCKET.put("k", String(a + b));
      return null;
    });
    return { sum: a + b };
  }
}
export default {
  fetch() {
    return new Response("ok");
  },
};
