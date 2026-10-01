import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // The e2e suite runs real test runners and Stryker; keep files sequential.
    fileParallelism: false,
  },
});
