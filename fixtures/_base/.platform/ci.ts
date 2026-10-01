// CI pipeline for @fixture/lib, evaluated by the platform's ci-engine.
//
// Self-contained on purpose (no imports): the engine calls the default export with a
// `ci` builder. `ci.runner()` starts a step; `step.runner()` starts a step that runs
// after `step` (in its workspace); awaiting a step waits for it to finish.
// `cache.inputs` lists the files whose content keys the step's cache.

type RunnerSpec = { name: string; command: string; cache?: { inputs: string[] } };
type Step = PromiseLike<unknown> & { runner(spec: RunnerSpec): Step };
type Ci = { runner(spec: RunnerSpec): Step };

const SOURCES = ["src/**", "tsconfig.json", "package.json"];

export default async (ci: Ci) => {
  const install = ci.runner({
    name: "install",
    command: "pnpm install --frozen-lockfile",
    cache: { inputs: ["pnpm-lock.yaml"] },
  });

  await Promise.all([
    install.runner({ name: "lint", command: "pnpm run lint", cache: { inputs: SOURCES } }),
    install.runner({ name: "typecheck", command: "pnpm run typecheck", cache: { inputs: SOURCES } }),
    install.runner({
      name: "test",
      command: "pnpm run test",
      cache: { inputs: [...SOURCES, "test/**"] },
    }),
  ]);

  await install.runner({ name: "build", command: "pnpm run build", cache: { inputs: SOURCES } });
};
