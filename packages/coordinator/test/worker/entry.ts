/** Test worker: the coordinator's real DO/Workflow classes over fake Ports and real bindings. */
import { type WorkflowLike, workflowHandle } from "../../src/cloudflare-bindings.js";
import { FakeQueueJobs, portsForRole } from "../../src/fakes/index.js";
import type { BatchRunParams } from "../../src/queue/batch-run.js";
import { configureCoordinatorRuntime } from "../../src/runtime.js";
import { fakePorts } from "./fixture.js";

configureCoordinatorRuntime({
  ports: (_env, role) => portsForRole(fakePorts(), role),
  // The agent-native MergeQueue DO: fake sandbox jobs, the real BatchRunWorkflow binding.
  mergeQueue: (env) => ({
    jobs: new FakeQueueJobs(fakePorts().git),
    batchRuns: workflowHandle(
      (env as { BATCH_RUN_WORKFLOW: WorkflowLike<BatchRunParams> }).BATCH_RUN_WORKFLOW,
    ),
  }),
});

export {
  BatchRunWorkflow,
  ChangeCoordinator,
  ChangeWorkflow,
  MergeQueue,
  PushRouter,
  RolloutWorkflow,
} from "../../src/workers.js";

export default {
  fetch(): Response {
    return new Response("coordinator test worker");
  },
};
