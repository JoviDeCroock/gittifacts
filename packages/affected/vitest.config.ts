import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    // Materializing the queue corpus (7 repos) is the long hook; give it room on loaded machines.
    hookTimeout: 300_000,
  },
});
