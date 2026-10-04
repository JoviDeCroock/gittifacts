/**
 * Tier 2, the post-deploy smoke (docs/testing.md): a few minutes against a DEPLOYED URL, right
 * after every deploy, from GitHub Actions (post-deploy-smoke.yml). A failure rolls the Worker back.
 *
 *   SMOKE_BASE_URL=https://gittifacts.decroockjovi.workers.dev \
 *   SMOKE_EXPECT_COMMIT=<12-char sha> pnpm --filter @app/e2e smoke
 *
 * Optional: E2E_EMAIL / E2E_PASSWORD (the dedicated E2E account; sign-in checks skip without
 * them), SMOKE_TTFG_BUDGET_S (the agent path's budget, default 120).
 */
import { defineConfig, devices } from "@playwright/test";

const baseURL = (process.env.SMOKE_BASE_URL ?? "").replace(/\/+$/, "");
if (baseURL === "") throw new Error("set SMOKE_BASE_URL to the deployed origin");
const CI = process.env.CI !== undefined && process.env.CI !== "";

export default defineConfig({
  testDir: "./tests/smoke",
  // The agent path waits for a real first green (CI + preview) under its own budget.
  timeout: 240_000,
  globalTimeout: 6 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: 3,
  reporter: CI
    ? [["list"], ["github"], ["html", { open: "never", outputFolder: "playwright-report/smoke" }], ["json", { outputFile: "test-results/smoke.json" }]]
    : [["list"]],
  outputDir: "test-results/smoke",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }, testMatch: /pages\.spec\.ts/ },
  ],
});
