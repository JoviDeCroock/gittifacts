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
import {
  type CiEngine,
  type Clock,
  type Ports,
  type PortsRole,
  type Reviewer,
  type Signer,
} from "@app/coordinator";
import {
  ArtifactsGitHost,
  ContainerSandboxJobs,
  FlagshipFlags,
  ObservabilityTelemetry,
  type RunnerLike,
  WorkersDeployer,
} from "@app/coordinator/adapters";
import { EngineKind, RunKeys, selectCiEngine } from "@app/ci-engine";
import * as gitwire from "@app/gitwire";
import { createReviewer, reviewerLlmFromEnv } from "@app/tour";
import { DoAudit } from "../audit/audit.js";
import { D1Notifier } from "../notifier.js";
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
  | "FLAGSHIP_APP_ID"
  | "AI_GATEWAY_ID"
  | "AUDIT_LOG"
  | "RUNNER"
  | "CI_RUN_WORKFLOW"
  | "CI_ENGINE"
  | "PLATFORM_SIGNING_KEY"
> & { AI?: Ai; AI_GATEWAY_TOKEN?: string };

/** The reviewer model when the repo policy does not override it (policy default is "auto"). */
export const DEFAULT_REVIEWER_MODEL = "auto";
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

/** `Reviewer` (@app/tour) whose model client is built on first use. */
export function lazyReviewer(env: unknown, model: string = DEFAULT_REVIEWER_MODEL): Reviewer {
  let reviewer: Reviewer | null = null;
  const get = (): Reviewer => {
    reviewer ??= createReviewer(reviewerLlmFromEnv(env, { model }), {
      principalId: "reviewer-agent",
    });
    return reviewer;
  };
  return {
    judge: (input) => get().judge(input),
    tour: (input) => get().tour(input),
  };
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
    start: (req) => get().start(req),
    status: (runId) => get().status(runId),
    cancel: (runId, reason) => get().cancel(runId, reason),
    restartFrom: (runId, step) => get().restartFrom(runId, step),
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
    // adapter's default guard).
    ...(role === "merge-queue" ? { canWrite: () => true } : {}),
  });
  const api = { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN };
  const ports: Ports = {
    store,
    git,
    sandbox: new ContainerSandboxJobs({
      runner: (name) => env.RUNNER.getByName(name) as unknown as RunnerLike,
      git,
      logKey: (jobId, step) => RunKeys.log(jobId, step),
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
    flags: new FlagshipFlags({ ...api, appId: env.FLAGSHIP_APP_ID }),
    telemetry: new ObservabilityTelemetry({ ...api, store, clock }),
    audit: new DoAudit(env),
    notifier: new D1Notifier(store, now),
    clock,
  };
  return { ...ports, ...opts.overrides };
}
