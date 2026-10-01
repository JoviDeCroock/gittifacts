/**
 * `CloudflareCiEngine`: the opt-in `CiEngine` backed by `@cloudflare/ci` (`GittifactsCIWorkflow`).
 * Same run records, status, cancel and restart-from-step semantics as `WorkflowsCiEngine`; it
 * differs in what runs the steps (the legacy `@cloudflare/sandbox` `Sandbox` class on a
 * default-policy container) and therefore in what it cannot do:
 *
 * - the pipeline must be in the request (no plan mode: `.platform/ci.ts` is resolved by the
 *   Workflows engine or the coordinator);
 * - `cancel()` terminates the Workflow but cannot stop a sandbox command already running;
 * - logs stay in `@cloudflare/ci` step outputs (`logRef` is null).
 *
 * This module does not import `@cloudflare/ci`; only `workflow.ts` does.
 */
import { type CiEngine, type CiRunParams, InvalidRunRequestError } from "../engine.js";
import {
  CiEngineConfigError,
  type CiEngineFactories,
  type CiEngineFactory,
  selectCiEngine,
} from "../select.js";
import type { ObjectStore } from "../storage.js";
import {
  WorkflowBackedEngine,
  type WorkflowBackedEngineOptions,
  type WorkflowLike,
} from "../workflows/engine.js";
import type { CfCiParams } from "./types.js";

export type CloudflareCiParams = CfCiParams<CiRunParams>;

export interface CloudflareCiEngineOptions extends WorkflowBackedEngineOptions<CloudflareCiParams> {
  /** Artifacts namespace (the `@cloudflare/ci` "owner"). */
  namespace: string;
  /** Ref reported to `@cloudflare/ci`. Default `refs/heads/main`. */
  ref?: string;
}

export class CloudflareCiEngine extends WorkflowBackedEngine<CloudflareCiParams> {
  readonly kind = "cloudflare-ci" as const;
  private readonly namespace: string;
  private readonly ref: string;

  constructor(options: CloudflareCiEngineOptions) {
    super(options);
    this.namespace = options.namespace;
    this.ref = options.ref ?? "refs/heads/main";
  }

  protected override validate(req: CiRunParams): void {
    if (req.pipeline === undefined || req.evidenceSteps === undefined) {
      throw new InvalidRunRequestError(
        'the "cloudflare-ci" engine needs an explicit pipeline and evidenceSteps (it has no plan mode)',
      );
    }
    if (req.pipeline.steps.some((st) => (st.artifacts?.length ?? 0) > 0)) {
      throw new InvalidRunRequestError(
        'the "cloudflare-ci" engine cannot upload build artifacts; use the workflows engine',
      );
    }
    if (req.network !== "open") {
      // Fail closed: @cloudflare/sandbox containers have open egress and no interception hook here.
      throw new InvalidRunRequestError(
        'the "cloudflare-ci" engine cannot restrict egress; use the workflows engine',
      );
    }
    if (req.seed !== undefined) {
      throw new InvalidRunRequestError('the "cloudflare-ci" engine cannot seed the global cache');
    }
  }

  protected params(req: CiRunParams): CloudflareCiParams {
    return {
      provider: "cloudflare-artifacts",
      providerData: { namespace: this.namespace },
      event: { type: "push" },
      owner: this.namespace,
      repo: req.artifactsRepo,
      sha: req.headSha,
      remote: "cloudflare",
      trigger: "push",
      ref: this.ref,
      beforeSha: req.baseSha,
      gittifacts: req,
    };
  }
}

/** Bindings the factory reads (wrangler names): `CF_CI_WORKFLOW`, `CI_BUCKET`, `CF_CI_NAMESPACE`. */
export interface CloudflareCiEnv {
  CF_CI_WORKFLOW: WorkflowLike<CloudflareCiParams>;
  CI_BUCKET: ObjectStore;
  CF_CI_NAMESPACE: string;
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    names.every((n) => typeof (value as Record<string, unknown>)[n] === "function")
  );
}

export function isCloudflareCiEnv(env: unknown): env is CloudflareCiEnv {
  if (typeof env !== "object" || env === null) return false;
  const e = env as Record<string, unknown>;
  return (
    hasMethods(e.CF_CI_WORKFLOW, ["create", "get"]) &&
    hasMethods(e.CI_BUCKET, ["get", "put", "delete", "list"]) &&
    typeof e.CF_CI_NAMESPACE === "string" &&
    e.CF_CI_NAMESPACE !== ""
  );
}

export const cloudflareCiEngineFactory: CiEngineFactory = (env: unknown): CiEngine => {
  if (!isCloudflareCiEnv(env)) {
    throw new CiEngineConfigError(
      'the "cloudflare-ci" engine needs the CF_CI_WORKFLOW (workflow → GittifactsCIWorkflow) and CI_BUCKET bindings and a CF_CI_NAMESPACE var',
    );
  }
  return new CloudflareCiEngine({
    workflow: env.CF_CI_WORKFLOW,
    bucket: env.CI_BUCKET,
    namespace: env.CF_CI_NAMESPACE,
  });
};

/** `selectCiEngine` with the cloudflare-ci factory registered. */
export function selectCiEngineWithCloudflare(
  env: Parameters<typeof selectCiEngine>[0],
  config: Parameters<typeof selectCiEngine>[1],
  factories: CiEngineFactories = {},
): CiEngine {
  return selectCiEngine(env, config, { "cloudflare-ci": cloudflareCiEngineFactory, ...factories });
}
