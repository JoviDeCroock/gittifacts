/**
 * Tier 1, the pre-deploy gate (docs/testing.md): browser and HTTP journeys against the real
 * platform Worker served locally by `wrangler dev --local` (server/serve.ts) with the integration
 * fakes for Artifacts, containers and the model. Runs on GitHub Actions in deploy-gate.yml.
 *
 *   pnpm --filter @app/e2e prepare-assets && pnpm --filter @app/e2e gate
 *
 * Flake policy: at most one retry, and a test that only passed on its retry is reported as
 * "flaky" in the summary (never silently green). No fixed sleeps: web-first assertions and
 * lib/poll.ts deadlines.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 8799);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const CI = process.env.CI !== undefined && process.env.CI !== "";

export default defineConfig({
  testDir: "./tests/gate",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 3 : 2,
  reporter: CI
    ? [["list"], ["github"], ["html", { open: "never", outputFolder: "playwright-report/gate" }], ["json", { outputFile: "test-results/gate.json" }]]
    : [["list"]],
  outputDir: "test-results/gate",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    {
      name: "phone",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
      // HTTP-only specs say the same thing at any width: run them once.
      testIgnore: /http\..*\.spec\.ts/,
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // Not bare `tsx`: Playwright run directly (not via pnpm) has no node_modules/.bin on PATH.
        command: "node node_modules/tsx/dist/cli.mjs server/serve.ts",
        url: `${baseURL}/start`,
        timeout: 180_000,
        reuseExistingServer: !CI,
        stdout: "pipe",
        stderr: "pipe",
      },
});
