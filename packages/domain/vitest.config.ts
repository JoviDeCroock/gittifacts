import { defineConfig } from "vitest/config";

// Its own config, so `vitest` here never climbs to the root's projects config (which would find
// no projects from this directory).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
