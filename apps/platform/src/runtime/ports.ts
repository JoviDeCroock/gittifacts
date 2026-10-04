/**
 * The coordinator's `Ports` on Cloudflare, built per role from the Worker's bindings.
 *
 * - `default`: everything except the merge queue. Its GitHost refuses to write anywhere but change
 *   forks (`task-*`), so no ChangeWorkflow, PushRouter, HTTP route or MCP tool can touch a main
 *   repo's refs.
 * - `merge-queue`: only the MergeQueue Durable Object gets this one. Its GitHost may write main
 *   repos (main-repo write tokens live <= 300 s inside the host and are never returned).
 *
 * Ports are cheap to build (no I/O). Ports that need configuration that may be missing in some
 * environments (the CI engine, the reviewer's model access, the signing key) are resolved on
 * first use, so a missing binding fails the call that needs it (which the coordinator treats as
 * an errored signal → escalate), not every request.
 */

import { EngineKind, RunKeys, selectCiEngine } from "@app/ci-engine";
import type { CiEngine, Clock, Ports, PortsRole, Reviewer, Signer } from "@app/coordinator";
import { isForkName, isGithubMirrorRepo } from "@app/coordinator";
import {
  ArtifactsGitHost,
  ContainerSandboxJobs,
  FlagshipFlags,
  ObservabilityTelemetry,
  type PlanCache,
  type RunnerLike,
  WorkersDeployer,
} from "@app/coordinator/adapters";
import * as gitwire from "@app/gitwire";
import { createReviewer, DEFAULT_PRICES, type PriceTable, reviewerLlmFromEnv } from "@app/tour";
import { DoAudit } from "../audit/audit.js";
import { withIntegrationEvents } from "../integrations/runtime.js";
import { D1Notifier } from "../notifier.js";
import { PlatformPreviews } from "../previews/port.js";
import { OnboardingMetrics } from "../projects/onboarding.js";
import { type PlatformSigner, platformSigner } from "../signing.js";
import { D1Store } from "../store/d1-store.js";
import { r2BundleLoader } from "./bundle.js";

/** The bindings and vars `buildPorts` reads (a subset of the generated `Env`). */
export type PortsEnv = Pick<
  Env,
  | "DB"
  | "BLOBS"
  | "CI_BUCKET"
  | "ARTIFACTS"
  | "ARTIFACTS_NAMESPACE"
  | "CF_ACCOUNT_ID"
  | "CF_API_TOKEN"
  | "AI_GATEWAY_ID"
  | "AUDIT_LOG"
  | "RUNNER"
  | "CI_RUN_WORKFLOW"
  | "CI_ENGINE"
  | "PLATFORM_SIGNING_KEY"
  | "PREVIEW_HOST"
  | "PREVIEW_HOST_SUFFIX"
  | "METRICS"
> & { AI?: Ai; AI_GATEWAY_TOKEN?: string; BROWSER?: BrowserRun };

/** The reviewer model when the repo policy does not override it (policy default is "auto"). */
export const DEFAULT_REVIEWER_MODEL = "auto";

/**
 * What a policy's `ai.reviewerModel: "auto"` resolves to on this platform: a Workers AI model,
 * routed through AI Gateway by the AI binding (no third-party key or credits needed). Live
 * dogfooding showed third-party ids fail through the binding without Unified Billing credits
 * (7003). Kimi K2.7 Code was the first default (DECISIONS.md 2026-10-02); GLM-5.3-Flash replaced it
 * to cut cost ~7-10x (owner's call, DECISIONS.md 2026-10-04). Override with the `REVIEWER_MODEL` var.
 */
export const PLATFORM_AUTO_REVIEWER_MODEL = "@cf/zai-org/glm-5.3-flash";

/**
 * Conservative per-token estimates for Workers AI models (billed in neurons; measured: Kimi
 * K2.7 Code ≈ 51 neurons for 63 in + 126 out tokens ≈ $0.0006). Over-estimating only makes
 * the per-change budget escalate sooner, never later.
 */
export const WORKERS_AI_PRICES: PriceTable = {
  "@cf/zai-org/glm-5.3-flash": { inputPerMTok: 0.15, outputPerMTok: 0.5 },
  "@cf/moonshotai/kimi-k2.7-code": { inputPerMTok: 1, outputPerMTok: 5 },
  "@cf/openai/gpt-oss-120b": { inputPerMTok: 0.5, outputPerMTok: 2 },
  "@cf/deepseek-ai/deepseek-v4-pro-0813": { inputPerMTok: 2, outputPerMTok: 8 },
};
/** Compatibility date for deployed bundles that do not carry one. */
export const DEFAULT_BUNDLE_COMPAT_DATE = "2026-09-30";

export interface BuildPortsOptions {
  clock?: Clock;
  /** Replace individual ports (tests swap the ones whose primitives are unavailable locally). */
  overrides?: Partial<Ports>;
}

/**
 * A `Signer` over the `PLATFORM_SIGNING_KEY` secret, parsed on first use. `keyId` is known once a
 * signature has been made (every caller signs before reading it) or when the secret declares it.
 */
export class LazySigner implements Signer {
  private loaded: PlatformSigner | null = null;
  private readonly declaredKeyId: string | null;

  constructor(private readonly env: Pick<PortsEnv, "PLATFORM_SIGNING_KEY">) {
    this.declaredKeyId = declaredKeyId(env.PLATFORM_SIGNING_KEY);
  }

  private async signer(): Promise<PlatformSigner> {
    this.loaded ??= await platformSigner(this.env);
    return this.loaded;
  }

  get keyId(): string {
    const id = this.loaded?.keyId ?? this.declaredKeyId;
    if (id === null) throw new Error("the platform signing key is not loaded yet");
    return id;
  }

  async signEvidence(payload: Parameters<Signer["signEvidence"]>[0]) {
    return (await this.signer()).signEvidence(payload);
  }

  async verifyEvidence(signed: Parameters<Signer["verifyEvidence"]>[0]) {
    return (await this.signer()).verifyEvidence(signed);
  }

  async signDocument(value: unknown): Promise<string> {
    return (await this.signer()).signDocument(value);
  }
}

function declaredKeyId(secret: string | undefined): string | null {
  if (!secret) return null;
  try {
    const parsed: unknown = JSON.parse(secret);
    if (typeof parsed === "object" && parsed !== null && "keyId" in parsed) {
      const id = (parsed as { keyId: unknown }).keyId;
      return typeof id === "string" && id !== "" ? id : null;
    }
  } catch {
    // Reported by platformSigner when a signature is needed.
  }
  return null;
}

/**
 * `Reviewer` (@app/tour) that honours the base policy's `ai.reviewerModel` (passed by the
 * coordinator as `input.model`). One model client per model, each built on first use.
 */
export function lazyReviewer(
  env: unknown,
  defaultModel: string = DEFAULT_REVIEWER_MODEL,
  factory: (model: string) => Reviewer = (model) => {
    const prices = { ...DEFAULT_PRICES, ...WORKERS_AI_PRICES };
    return createReviewer(reviewerLlmFromEnv(env, { model, prices }), {
      principalId: "reviewer-agent",
      prices,
    });
  },
): Reviewer {
  const reviewers = new Map<string, Reviewer>();
  const autoModel = reviewerAutoModel(env);
  const get = (model: string | undefined): Reviewer => {
    const requested = model === undefined || model.trim() === "" ? defaultModel : model.trim();
    const key = requested === "auto" ? autoModel : requested;
    let reviewer = reviewers.get(key);
    if (reviewer === undefined) {
      reviewer = factory(key);
      reviewers.set(key, reviewer);
    }
    return reviewer;
  };
  return {
    judge: async ({ model, ...input }) => get(model).judge(input),
    tour: async ({ model, ...input }) => get(model).tour(input),
  };
}

/** The model a policy's `ai.reviewerModel` resolves to here ("auto": the platform default). */
export function resolveReviewerModel(env: unknown, policyModel: string | undefined): string {
  const m = policyModel?.trim() ?? "";
  return m === "" || m === "auto" ? reviewerAutoModel(env) : m;
}

function reviewerAutoModel(env: unknown): string {
  if (typeof env === "object" && env !== null && "REVIEWER_MODEL" in env) {
    const v = (env as { REVIEWER_MODEL?: unknown }).REVIEWER_MODEL;
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return PLATFORM_AUTO_REVIEWER_MODEL;
}

/** `CiEngine` (@app/ci-engine `selectCiEngine`) chosen by `CI_ENGINE`, built on first use. */
export function lazyCiEngine(env: PortsEnv): CiEngine {
  let engine: CiEngine | null = null;
  const get = (): CiEngine => {
    if (engine === null) {
      const kind = EngineKind.safeParse(env.CI_ENGINE);
      if (!kind.success) throw new Error(`CI_ENGINE "${env.CI_ENGINE}" is not a known engine`);
      // `cloudflare-ci` is opt-in (DECISIONS.md): without its factory selectCiEngine refuses it.
      engine = selectCiEngine(env, { engine: kind.data });
    }
    return engine;
  };
  return {
    start: async (req) => get().start(req),
    status: async (runId) => get().status(runId),
    cancel: async (runId, reason) => get().cancel(runId, reason),
    restartFrom: async (runId, step) => get().restartFrom(runId, step),
  };
}

export function buildPorts(env: PortsEnv, role: PortsRole, opts: BuildPortsOptions = {}): Ports {
  const clock = opts.clock ?? { now: () => new Date() };
  const now = () => clock.now();
  const store = new D1Store(env.DB, env.BLOBS, now);
  const git = new ArtifactsGitHost({
    binding: env.ARTIFACTS,
    wire: gitwire,
    namespace: env.ARTIFACTS_NAMESPACE,
    accountId: env.CF_ACCOUNT_ID,
    // Only the merge queue writes main repos; everyone else may write change forks only (the
    // adapter's default guard). GitHub mode's sync also writes its mirrors (`ghm-*`), whose source
    // of truth is GitHub (never a native main repo).
    ...(role === "merge-queue" ? { canWrite: () => true } : {}),
    ...(role === "github"
      ? { canWrite: (repo: string) => isForkName(repo) || isGithubMirrorRepo(repo) }
      : {}),
  });
  const api = { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN };
  const ports: Ports = {
    store,
    git,
    sandbox: new ContainerSandboxJobs({
      runner: (name) => env.RUNNER.getByName(name) as unknown as RunnerLike,
      git,
      logKey: (jobId, step) => RunKeys.log(jobId, step),
      planCache: r2PlanCache(env.BLOBS),
    }),
    ci: lazyCiEngine(env),
    reviewer: lazyReviewer(env),
    signer: new LazySigner(env),
    deployer: new WorkersDeployer({
      ...api,
      loadBundle: r2BundleLoader(env.CI_BUCKET, {
        compatibilityDate: DEFAULT_BUNDLE_COMPAT_DATE,
      }),
    }),
    // One Flagship app per project (its change flags; its Workers bind FLAGS to it only). The
    // platform's own flags (FLAGSHIP_APP_ID, bound as the platform Worker's FLAGS) stay apart.
    flags: new FlagshipFlags(api),
    telemetry: new ObservabilityTelemetry({ ...api, store, clock }),
    audit: new DoAudit(env),
    notifier: new D1Notifier(store, now),
    clock,
    previews: new PlatformPreviews(env, store, now),
    onboarding: new OnboardingMetrics(store, env),
  };
  // Change rows and sealed evidence also feed external integrations (webhooks, preview evidence).
  return withIntegrationEvents({ ...ports, ...opts.overrides }, env);
}

/** Plans keyed by `.platform/ci.ts` content hash, so unchanged pipelines skip the plan container. */
function r2PlanCache(bucket: R2Bucket): PlanCache {
  return {
    async get(key) {
      const object = await bucket.get(`plan-cache/${key}.json`);
      return object === null ? null : ((await object.json()) as unknown);
    },
    async put(key, spec) {
      await bucket.put(`plan-cache/${key}.json`, JSON.stringify(spec), {
        httpMetadata: { contentType: "application/json" },
      });
    },
  };
}
