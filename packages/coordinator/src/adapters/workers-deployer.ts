/**
 * `Deployer` on the Workers Scripts / Versions / Deployments REST API (release-observability.md §4):
 * - first deploy (the script does not exist yet): `PUT /workers/scripts/{script}` (multipart)
 *   creates it with the bundle at 100%; the response's `deployment_id` is that version. Then
 *   workers.dev is turned on (`POST …/subdomain`) so the project has a URL;
 * - later uploads: `POST /workers/scripts/{script}/versions` (multipart), not deployed;
 * - every upload: `PATCH …/script-settings` with observability on (logs + Workers Issues): rollout
 *   health reads Workers Logs per version, so a script without them could never regress;
 * - split / rollback: `POST …/deployments {strategy:"percentage"}`. Rollback is a deployment with
 *   100% on the old version (no rollback endpoint); error 10220 (secrets changed since that
 *   version) is retried with `?force=true`.
 *
 * Versions are tagged with the change id (`workers/tag`) and the merged sha (`workers/commit_sha`).
 *
 * **Bindings.** User Workers run in the platform's account, so a bundle may declare only plain vars
 * (`plain_text`, `json`); anything else could bind the platform's own resources and is refused.
 * The deployer adds the platform's bindings to every version: `FLAGS` (the Flagship app holding the
 * per-change kill-switch flags, read with `isChangeEnabled(env.FLAGS, changeId)`) and `VERSION`
 * (`version_metadata`: `{ id, tag, timestamp }`).
 *
 * The bundle comes from the CI `build` step (stored by reference); `loadBundle` turns a
 * `bundleRef` into modules + metadata (e.g. from R2).
 */
import { z } from "zod";
import type { Deployer } from "../ports.js";
import { CfApiError, type CfApiOptions, cfRequest } from "./cf-api.js";

export interface WorkerModule {
  name: string;
  content: Uint8Array | string;
  contentType?: string;
}

export interface WorkerBundle {
  mainModule: string;
  modules: WorkerModule[];
  /**
   * Version metadata from the build (compatibility_date, compatibility_flags, bindings, …).
   * `main_module` and `annotations` are set by the deployer, and `bindings` gets the platform's.
   */
  metadata: Record<string, unknown>;
}

export interface WorkersDeployerOptions extends CfApiOptions {
  loadBundle(bundleRef: string): Promise<WorkerBundle>;
  /** Flagship app bound as `FLAGS` in every version (env FLAGSHIP_APP_ID); absent: no `FLAGS`. */
  flagshipAppId?: string;
  /** Turn workers.dev on for scripts the deployer creates (default true). */
  workersDev?: boolean;
}

/** Binding names the platform owns in every deployed Worker. */
export const FLAGS_BINDING = "FLAGS";
export const VERSION_BINDING = "VERSION";

/** Script settings every deployed Worker gets: Workers Logs (all invocations) and Workers Issues. */
export const DEPLOY_OBSERVABILITY = {
  enabled: true,
  head_sampling_rate: 1,
  logs: { enabled: true, invocation_logs: true },
  issues: { enabled: true },
} as const;

const SECRETS_CHANGED = 10220;
const SCRIPT_NOT_FOUND = 10007;
/** Binding types a bundle may declare itself: plain values, never resources. */
const USER_BINDING_TYPES: ReadonlySet<string> = new Set(["plain_text", "json"]);

export class BundleBindingError extends Error {
  override name = "BundleBindingError";
}

export function moduleContentType(name: string): string {
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "application/javascript+module";
  if (name.endsWith(".cjs")) return "application/javascript";
  if (name.endsWith(".wasm")) return "application/wasm";
  if (name.endsWith(".map")) return "application/source-map";
  if (name.endsWith(".json")) return "application/json";
  return "text/plain";
}

export function isScriptNotFound(e: unknown): boolean {
  return e instanceof CfApiError && (e.status === 404 || e.hasCode(SCRIPT_NOT_FOUND));
}

/** `deployment_id` comes back as a UUID without hyphens; version ids elsewhere have them. */
export function hyphenateUuid(id: string): string {
  return /^[0-9a-f]{32}$/i.test(id)
    ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
    : id;
}

/**
 * The bindings a deployed version gets: the bundle's own plain vars (validated) plus `FLAGS` and
 * `VERSION`. Throws `BundleBindingError` for any other binding or a reserved name.
 */
export function deployBindings(
  declared: unknown,
  flagshipAppId: string | undefined,
): Array<Record<string, unknown>> {
  const own = Array.isArray(declared) ? declared : [];
  const reserved = new Set([FLAGS_BINDING, VERSION_BINDING]);
  const out: Array<Record<string, unknown>> = [];
  for (const b of own) {
    const binding = (typeof b === "object" && b !== null ? b : {}) as Record<string, unknown>;
    const type = typeof binding.type === "string" ? binding.type : "?";
    const name = typeof binding.name === "string" ? binding.name : "?";
    if (!USER_BINDING_TYPES.has(type))
      throw new BundleBindingError(
        `binding ${name} (${type}) is not allowed: deployed Workers may declare only vars (plain_text, json); the platform adds ${FLAGS_BINDING} and ${VERSION_BINDING}`,
      );
    if (reserved.has(name))
      throw new BundleBindingError(`binding name ${name} is reserved for the platform`);
    out.push(binding);
  }
  if (flagshipAppId !== undefined && flagshipAppId !== "")
    out.push({ type: "flagship", name: FLAGS_BINDING, app_id: flagshipAppId });
  out.push({ type: "version_metadata", name: VERSION_BINDING });
  return out;
}

const Deployments = z
  .object({
    deployments: z.array(
      z
        .object({
          created_on: z.string().optional(),
          versions: z.array(
            z.object({ version_id: z.string(), percentage: z.number() }).passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export class WorkersDeployer implements Deployer {
  constructor(private readonly opts: WorkersDeployerOptions) {}

  private scriptPath(script: string, tail?: string): string {
    const base = `/workers/scripts/${encodeURIComponent(script)}`;
    return tail === undefined ? base : `${base}/${tail}`;
  }

  async uploadVersion(input: {
    script: string;
    changeId: string;
    sha: string;
    bundleRef: string;
    message: string;
  }): Promise<{ versionId: string }> {
    const bundle = await this.opts.loadBundle(input.bundleRef);
    const metadata = {
      ...bundle.metadata,
      main_module: bundle.mainModule,
      bindings: deployBindings(bundle.metadata.bindings, this.opts.flagshipAppId),
      annotations: {
        "workers/message": input.message.slice(0, 1000),
        "workers/tag": input.changeId.slice(0, 100),
        "workers/commit_sha": input.sha.slice(0, 64),
      },
    };
    let versionId: string;
    try {
      const result = await cfRequest(
        this.opts,
        {
          method: "POST",
          path: this.scriptPath(input.script, "versions"),
          form: uploadForm(bundle, metadata),
        },
        z.object({ id: z.string().min(1) }).passthrough(),
      );
      versionId = result.id;
    } catch (e) {
      if (!isScriptNotFound(e)) throw e;
      versionId = await this.createScript(input.script, bundle, metadata);
    }
    await this.ensureObservability(input.script);
    return { versionId };
  }

  /**
   * First deploy: create the script with this bundle at 100% (a new script has no previous
   * version to split against), and give it a workers.dev URL.
   */
  private async createScript(
    script: string,
    bundle: WorkerBundle,
    metadata: Record<string, unknown>,
  ): Promise<string> {
    const created = await cfRequest(
      this.opts,
      {
        method: "PUT",
        path: this.scriptPath(script),
        query: { excludeScript: "true" },
        form: uploadForm(bundle, { ...metadata, observability: DEPLOY_OBSERVABILITY }),
      },
      z.object({ deployment_id: z.string().nullish() }).passthrough(),
    );
    if (this.opts.workersDev !== false) {
      await cfRequest(
        this.opts,
        {
          method: "POST",
          path: this.scriptPath(script, "subdomain"),
          json: { enabled: true, previews_enabled: false },
        },
        z.unknown(),
      );
    }
    if (created.deployment_id) return hyphenateUuid(created.deployment_id);
    const live = await this.currentVersions(script);
    const versionId = live.find((v) => v.percentage > 0)?.versionId;
    if (versionId === undefined) throw new Error(`created ${script} but found no deployed version`);
    return versionId;
  }

  private async ensureObservability(script: string): Promise<void> {
    await cfRequest(
      this.opts,
      {
        method: "PATCH",
        path: this.scriptPath(script, "script-settings"),
        json: { observability: DEPLOY_OBSERVABILITY },
      },
      z.unknown(),
    );
  }

  /** Versions of the newest deployment; `[]` for a script that does not exist yet. */
  async currentVersions(script: string): Promise<Array<{ versionId: string; percentage: number }>> {
    let result: z.infer<typeof Deployments>;
    try {
      result = await cfRequest(
        this.opts,
        { method: "GET", path: this.scriptPath(script, "deployments") },
        Deployments,
      );
    } catch (e) {
      if (isScriptNotFound(e)) return [];
      throw e;
    }
    // The newest deployment (by created_on) is the active one.
    const latest = [...result.deployments].sort((a, b) =>
      (b.created_on ?? "").localeCompare(a.created_on ?? ""),
    )[0];
    return (latest?.versions ?? []).map((v) => ({
      versionId: v.version_id,
      percentage: v.percentage,
    }));
  }

  async setSplit(
    script: string,
    split: Array<{ versionId: string; percentage: number }>,
    message: string,
  ): Promise<void> {
    const total = split.reduce((n, s) => n + s.percentage, 0);
    if (Math.abs(total - 100) > 1e-9)
      throw new Error(`deployment split must total 100, got ${total}`);
    if (split.length > 2)
      throw new Error("a deployment can split traffic between at most 2 versions");
    await this.deploy(script, split, message, false);
  }

  async rollback(script: string, versionId: string, message: string): Promise<void> {
    try {
      await this.deploy(script, [{ versionId, percentage: 100 }], message, false);
    } catch (e) {
      if (!(e instanceof CfApiError && e.hasCode(SECRETS_CHANGED))) throw e;
      await this.deploy(script, [{ versionId, percentage: 100 }], message, true);
    }
  }

  private async deploy(
    script: string,
    split: Array<{ versionId: string; percentage: number }>,
    message: string,
    force: boolean,
  ): Promise<void> {
    await cfRequest(
      this.opts,
      {
        method: "POST",
        path: this.scriptPath(script, "deployments"),
        ...(force ? { query: { force: "true" } } : {}),
        json: {
          strategy: "percentage",
          versions: split
            .filter((s) => s.percentage > 0)
            .map((s) => ({ version_id: s.versionId, percentage: s.percentage })),
          // Only `workers/message`: the API rejects `workers/triggered_by` on deployments
          // (10210 "Invalid annotations", live 2026-10-02), although wrangler's types list it.
          annotations: { "workers/message": message.slice(0, 1000) },
        },
      },
      z.unknown(),
    );
  }
}

function uploadForm(bundle: WorkerBundle, metadata: Record<string, unknown>): FormData {
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const m of bundle.modules) {
    const bytes = typeof m.content === "string" ? new TextEncoder().encode(m.content) : m.content;
    form.set(
      m.name,
      new Blob([new Uint8Array(bytes)], { type: m.contentType ?? moduleContentType(m.name) }),
      m.name,
    );
  }
  return form;
}
