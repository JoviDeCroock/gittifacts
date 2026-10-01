import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "cli",
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
