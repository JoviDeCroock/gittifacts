import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Workspace packages resolve to their sources (the fixture is never installed).
const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@queue\/money$/, replacement: at("packages/money/src/index.ts") },
      { find: /^@queue\/text\/(.*)$/, replacement: at("packages/text/src/$1.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
