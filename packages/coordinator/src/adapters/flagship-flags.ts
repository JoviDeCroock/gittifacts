/**
 * `Flags` on Flagship REST (docs/research/release-observability.md §1). One boolean flag per
 * change, `change-<id>`: variations on=true/off=false, default `off`, one match-all rule serving
 * `on`. A disabled flag serves its default (`off`), which is the kill switch.
 *
 * Update is a full-replacement PUT (no PATCH), so `setEnabled` is GET → flip → PUT. There is no
 * ETag: concurrent writers can clobber each other, but only the rollout/kill paths write these
 * flags and they are serialized per change.
 */
import { z } from "zod";
import { flagKeyFor } from "../ids.js";
import type { Flags } from "../ports.js";
import { CfApiError, type CfApiOptions, cfRequest } from "./cf-api.js";

export interface FlagshipFlagsOptions extends CfApiOptions {
  /** Flagship app id (env FLAGSHIP_APP_ID). */
  appId: string;
}

const FlagDefinition = z
  .object({
    key: z.string(),
    enabled: z.boolean(),
    description: z.string().nullable().optional(),
    variations: z.record(z.string(), z.unknown()),
    default_variation: z.string(),
    rules: z.array(z.unknown()),
  })
  .passthrough();
type FlagDefinition = z.infer<typeof FlagDefinition>;

/** Fields the API sets itself; never sent back on PUT. */
const READ_ONLY = new Set(["id", "created_at", "updated_at", "created_by", "updated_by", "version", "app_id"]);

export function changeFlagDefinition(key: string, enabled: boolean, description: string): FlagDefinition {
  return {
    key,
    enabled,
    description: description.slice(0, 500),
    variations: { on: true, off: false },
    default_variation: "off",
    rules: [{ priority: 1, serve_variation: "on", conditions: [] }],
  };
}

function writable(def: FlagDefinition): Record<string, unknown> {
  return Object.fromEntries(Object.entries(def).filter(([k]) => !READ_ONLY.has(k)));
}

export class FlagshipFlags implements Flags {
  constructor(private readonly opts: FlagshipFlagsOptions) {}

  private path(key?: string): string {
    const base = `/flagship/apps/${encodeURIComponent(this.opts.appId)}/flags`;
    return key === undefined ? base : `${base}/${encodeURIComponent(key)}`;
  }

  private async get(key: string): Promise<FlagDefinition | null> {
    try {
      return await cfRequest(this.opts, { method: "GET", path: this.path(key) }, FlagDefinition);
    } catch (e) {
      if (e instanceof CfApiError && e.status === 404) return null;
      throw e;
    }
  }

  private async put(def: FlagDefinition): Promise<void> {
    await cfRequest(this.opts, { method: "PUT", path: this.path(def.key), json: writable(def) }, z.unknown());
  }

  async ensureChangeFlag(changeId: string, opts: { enabled: boolean; description: string }): Promise<string> {
    const key = flagKeyFor(changeId);
    const existing = await this.get(key);
    if (existing === null) {
      try {
        await cfRequest(
          this.opts,
          { method: "POST", path: this.path(), json: changeFlagDefinition(key, opts.enabled, opts.description) },
          z.unknown(),
        );
        return key;
      } catch (e) {
        if (!(e instanceof CfApiError && e.status === 409)) throw e;
        // Created concurrently: fall through and reconcile `enabled`.
      }
    }
    const current = existing ?? (await this.get(key));
    if (current !== null && current.enabled !== opts.enabled) await this.put({ ...current, enabled: opts.enabled });
    return key;
  }

  async setEnabled(flagKey: string, enabled: boolean): Promise<void> {
    const current = await this.get(flagKey);
    if (current === null) {
      // Turning off a flag that does not exist: create it disabled so the kill sticks.
      if (!enabled) {
        await cfRequest(
          this.opts,
          { method: "POST", path: this.path(), json: changeFlagDefinition(flagKey, false, "created disabled by the kill switch") },
          z.unknown(),
        );
      }
      return;
    }
    if (current.enabled === enabled) return;
    await this.put({ ...current, enabled });
  }
}
