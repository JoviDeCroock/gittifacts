import { defineConfig } from "vitest/config";

// `vitest run <file>` at the root (what the platform's evidence runner does for red/green, test
// runs and coverage) hands each test file to its own package's project and config: the workerd
// pool for the Worker packages, node for the rest. Packages still run their own suites as before.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
