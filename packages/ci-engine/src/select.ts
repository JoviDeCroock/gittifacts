import type { CiEngine, EngineKind } from "./engine.js";
import type { ObjectStore } from "./storage.js";
import {
  type RunnerControlNamespace,
  type WorkflowLike,
  WorkflowsCiEngine,
} from "./workflows/engine.js";

/**
 * Bindings `selectCiEngine` reads. Names are the platform's wrangler binding names:
 * `CI_RUN_WORKFLOW` (workflow → CiRunWorkflow), `CI_BUCKET` (R2), `RUNNER` (DO → Runner).
 */
export interface CiEngineEnv {
  CI_RUN_WORKFLOW?: WorkflowLike;
  CI_BUCKET?: ObjectStore;
  RUNNER?: RunnerControlNamespace;
}

export type CiEngineFactory = (env: unknown) => CiEngine;

export interface CiEngineFactories {
  /** From `@app/ci-engine/cloudflare` (`cloudflareCiEngineFactory`). Opt-in, never imported here. */
  "cloudflare-ci"?: CiEngineFactory;
}

export class CiEngineConfigError extends Error {
  override readonly name = "CiEngineConfigError";
}

export function selectCiEngine(
  env: CiEngineEnv,
  config: { engine: EngineKind },
  factories: CiEngineFactories = {},
): CiEngine {
  switch (config.engine) {
    case "workflows": {
      if (env.CI_RUN_WORKFLOW === undefined || env.CI_BUCKET === undefined) {
        throw new CiEngineConfigError(
          'the "workflows" CI engine needs the CI_RUN_WORKFLOW and CI_BUCKET bindings',
        );
      }
      return new WorkflowsCiEngine({
        workflow: env.CI_RUN_WORKFLOW,
        bucket: env.CI_BUCKET,
        ...(env.RUNNER === undefined ? {} : { runners: env.RUNNER }),
      });
    }
    case "cloudflare-ci": {
      const factory = factories["cloudflare-ci"];
      if (factory === undefined) {
        throw new CiEngineConfigError(
          'the "cloudflare-ci" engine is opt-in: pass `{ "cloudflare-ci": cloudflareCiEngineFactory }` from "@app/ci-engine/cloudflare"',
        );
      }
      return factory(env);
    }
  }
}
