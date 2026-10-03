// CI pipeline for the gittifacts monorepo (hand-written from the detected proposal; edits to
// .platform/** are always Lane 2 and need a human's approval).
//
// Self-contained on purpose (no imports): the platform evaluates this file in a sandbox with a
// `ci` builder. `await ci.runner()` runs a step from a fresh checkout and resolves to the finished
// step; `step.runner()` runs a step from that step's snapshot (so it reuses the install). Steps
// started without awaiting in between run in parallel.
// The platform adds its evidence steps (red/green, coverage, public API, ...) after these; they run
// vitest at the root, where vitest.config.ts hands each test file to its package's project.
//
// Mirrors the GitHub deploy gate (.github/workflows/deploy-gate.yml): built assets, every
// package's typecheck, the platform's workerd suite; plus the fast unit suites. Not here, on
// purpose: root `biome check .` (red on main: formatting debt, not enforced anywhere yet) and the
// ci-engine / coordinator / gitwire / merge-queue suites (container-only flakes and live tests;
// they run locally and in the deploy gate's typecheck).

type RunnerSpec = {
  name: string;
  command: string;
  cache?: { inputs: string[] };
  artifacts?: { name: string; paths: string[] }[];
};
type Step = { runner(spec: RunnerSpec): Promise<Step> };
type Ci = Step;

const UNIT = [
  "@app/evidence",
  "@app/domain",
  "@app/classifier",
  "@app/conventions",
  "@app/tour",
  "@app/resolver",
  "@app/web",
  "@app/mcp",
  "@app/host",
  "@app/core",
];

export default async (ci: Ci) => {
  const install = await ci.runner({
    name: "install",
    command: "pnpm install --frozen-lockfile",
    cache: { inputs: ["**/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"] },
  });

  // What the platform's tests and typecheck read: templates, web assets, docs, the CLI tarball.
  const assets = await install.runner({
    name: "assets",
    command: [
      "pnpm --filter @app/platform run bundle-templates",
      "pnpm --filter @app/web build",
      "pnpm --filter @app/docs build",
      "pnpm --filter gittifacts pack:assets",
    ].join(" && "),
  });

  await Promise.all([
    assets.runner({ name: "typecheck", command: "pnpm -r typecheck" }),
    assets.runner({
      name: "platform-tests",
      command: "cd apps/platform && CI=1 pnpm exec vitest run --maxWorkers=2",
    }),
    install.runner({
      name: "test",
      command: `pnpm ${UNIT.map((p) => `--filter ${p}`).join(" ")} run test`,
    }),
    install.runner({ name: "docs", command: "pnpm --filter @app/docs check" }),
  ]);
};
