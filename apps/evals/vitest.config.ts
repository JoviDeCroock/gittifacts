import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts"],
          testTimeout: 20_000,
        },
      },
      {
        // Test-only Worker config (no containers, no remote AI): the entry swaps in a fake
        // container, a scripted model and a fake platform through the seams.
        plugins: [cloudflareTest({ wrangler: { configPath: "./test/worker/wrangler.jsonc" } })],
        test: { name: "worker", include: ["test/worker/**/*.test.ts"], testTimeout: 60_000 },
      },
    ],
  },
});
