/**
 * Fake Ports shared by the test file and the Durable Objects / Workflows running in the test
 * worker (kept on globalThis so both sides see the same instance whatever the module graph).
 */
import { createFakePorts, type FakePorts } from "../../src/fakes/index.js";

const KEY = "__gittifactsCoordinatorFixture";

export function fakePorts(): FakePorts {
  const g = globalThis as unknown as Record<string, FakePorts | undefined>;
  let ports = g[KEY];
  if (ports === undefined) {
    ports = createFakePorts();
    g[KEY] = ports;
  }
  return ports;
}

export function resetFakePorts(): FakePorts {
  const ports = createFakePorts();
  (globalThis as unknown as Record<string, FakePorts>)[KEY] = ports;
  return ports;
}
