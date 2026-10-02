import { defineConfig } from "vitest/config";

/** Node-side tests: the workspace container scripts run for real with sh, git and node. */
export default defineConfig({
  test: {
    name: "platform-node",
    environment: "node",
    include: ["test-node/**/*.spec.ts"],
    testTimeout: 60_000,
  },
});
