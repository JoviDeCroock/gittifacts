/**
 * `Deployer` on the Workers Versions/Deployments REST API (release-observability.md §4):
 * - upload: POST /workers/scripts/{script}/versions (multipart: `metadata` + modules), tagged
 *   with the change id (`workers/tag`) and the merged sha (`workers/commit_sha`);
 * - split / rollback: POST /workers/scripts/{script}/deployments {strategy:"percentage"}.
 *   Rollback is a deployment with 100% on the old version (no rollback endpoint); error 10220
 *   (secrets changed since that version) is retried with `?force=true`.
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
   * `main_module` and `annotations` are set by the deployer.
   */
  metadata: Record<string, unknown>;
}

export interface WorkersDeployerOptions extends CfApiOptions {
  loadBundle(bundleRef: string): Promise<WorkerBundle>;
}

const SECRETS_CHANGED = 10220;

export function moduleContentType(name: string): string {
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "application/javascript+module";
  if (name.endsWith(".cjs")) return "application/javascript";
  if (name.endsWith(".wasm")) return "application/wasm";
  if (name.endsWith(".map")) return "application/source-map";
  if (name.endsWith(".json")) return "application/json";
  return "text/plain";
}

const Deployments = z
  .object({
    deployments: z.array(
      z
        .object({
          created_on: z.string().optional(),
          versions: z.array(z.object({ version_id: z.string(), percentage: z.number() }).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export class WorkersDeployer implements Deployer {
  constructor(private readonly opts: WorkersDeployerOptions) {}

  private scriptPath(script: string, tail: string): string {
    return `/workers/scripts/${encodeURIComponent(script)}/${tail}`;
  }

  async uploadVersion(input: { script: string; changeId: string; sha: string; bundleRef: string; message: string }): Promise<{ versionId: string }> {
    const bundle = await this.opts.loadBundle(input.bundleRef);
    const metadata = {
      ...bundle.metadata,
      main_module: bundle.mainModule,
      annotations: {
        "workers/message": input.message.slice(0, 1000),
        "workers/tag": input.changeId.slice(0, 100),
        "workers/commit_sha": input.sha.slice(0, 64),
      },
    };
    const form = new FormData();
    form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    for (const m of bundle.modules) {
      const bytes = typeof m.content === "string" ? new TextEncoder().encode(m.content) : m.content;
      form.set(m.name, new Blob([new Uint8Array(bytes)], { type: m.contentType ?? moduleContentType(m.name) }), m.name);
    }
    const result = await cfRequest(
      this.opts,
      { method: "POST", path: this.scriptPath(input.script, "versions"), form },
      z.object({ id: z.string().min(1) }).passthrough(),
    );
    return { versionId: result.id };
  }

  async currentVersions(script: string): Promise<Array<{ versionId: string; percentage: number }>> {
    const result = await cfRequest(this.opts, { method: "GET", path: this.scriptPath(script, "deployments") }, Deployments);
    // The newest deployment (by created_on) is the active one.
    const latest = [...result.deployments].sort((a, b) => (b.created_on ?? "").localeCompare(a.created_on ?? ""))[0];
    return (latest?.versions ?? []).map((v) => ({ versionId: v.version_id, percentage: v.percentage }));
  }

  async setSplit(script: string, split: Array<{ versionId: string; percentage: number }>, message: string): Promise<void> {
    const total = split.reduce((n, s) => n + s.percentage, 0);
    if (Math.abs(total - 100) > 1e-9) throw new Error(`deployment split must total 100, got ${total}`);
    if (split.length > 2) throw new Error("a deployment can split traffic between at most 2 versions");
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
          versions: split.filter((s) => s.percentage > 0).map((s) => ({ version_id: s.versionId, percentage: s.percentage })),
          annotations: { "workers/message": message.slice(0, 1000), "workers/triggered_by": "gittifacts" },
        },
      },
      z.unknown(),
    );
  }
}
