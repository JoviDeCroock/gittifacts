/** Test worker: the coordinator's real DO/Workflow classes over fake Ports and real bindings. */
import { portsForRole } from "../../src/fakes/index.js";
import { configureCoordinatorRuntime } from "../../src/runtime.js";
import { fakePorts } from "./fixture.js";

configureCoordinatorRuntime({ ports: (_env, role) => portsForRole(fakePorts(), role) });

export {
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
