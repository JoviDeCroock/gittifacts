/**
 * `Flags` on Flagship REST (docs/research/release-observability.md §1). Every project has its own
 * app (`project-flags.ts`); the app id is an argument of every call, so one adapter serves all
 * projects and no call can touch an app it was not given.
 *
 * Apps: `GET /apps` (no pagination), `POST /apps {name}` (names are not unique), `DELETE
 * /apps/{id}` (409 while a Worker still binds the app). One boolean flag per change,
 * `change-<id>`: variations on=true/off=false, default `off`, one match-all rule serving `on`. A
 * disabled flag serves its default (`off`), which is the kill switch.
 *
 * Update is a full-replacement PUT (no PATCH), so `setEnabled` is GET → flip → PUT. There is no
 * ETag: concurrent writers can clobber each other, but only the rollout/kill paths write these
 * flags and they are serialized per change.
 */
import { z } from "zod";
import { flagKeyFor } from "../ids.js";
import type { Flags } from "../ports.js";
import { CfApiError, type CfApiOptions, cfRequest } from "./cf-api.js";

export type FlagshipFlagsOptions = CfApiOptions;

const App = z
  .object({ id: z.string().min(1), name: z.string(), created_at: z.string().optional() })
  .passthrough();

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
const READ_ONLY = new Set([
  "id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "version",
  "app_id",
]);

export function changeFlagDefinition(
  key: string,
  enabled: boolean,
  description: string,
): FlagDefinition {
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

  private path(appId: string, key?: string): string {
    const base = `/flagship/apps/${encodeURIComponent(appId)}/flags`;
    return key === undefined ? base : `${base}/${encodeURIComponent(key)}`;
  }

  async ensureApp(name: string): Promise<string> {
    const apps = await cfRequest(
      this.opts,
      { method: "GET", path: "/flagship/apps" },
      z.array(App),
    );
    const oldest = apps
      .filter((a) => a.name === name)
      .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))[0];
    if (oldest !== undefined) return oldest.id;
    const created = await cfRequest(
      this.opts,
      { method: "POST", path: "/flagship/apps", json: { name } },
      App,
    );
    return created.id;
  }

  async deleteApp(appId: string): Promise<void> {
    try {
      await cfRequest(
        this.opts,
        { method: "DELETE", path: `/flagship/apps/${encodeURIComponent(appId)}` },
        z.unknown(),
      );
    } catch (e) {
      if (e instanceof CfApiError && e.status === 404) return;
      throw e;
    }
  }

  private async get(appId: string, key: string): Promise<FlagDefinition | null> {
    try {
      return await cfRequest(
        this.opts,
        { method: "GET", path: this.path(appId, key) },
        FlagDefinition,
      );
    } catch (e) {
      if (e instanceof CfApiError && e.status === 404) return null;
      throw e;
    }
  }

  private async put(appId: string, def: FlagDefinition): Promise<void> {
    await cfRequest(
      this.opts,
      { method: "PUT", path: this.path(appId, def.key), json: writable(def) },
      z.unknown(),
    );
  }

  async ensureChangeFlag(
    appId: string,
    changeId: string,
    opts: { enabled: boolean; description: string },
  ): Promise<string> {
    const key = flagKeyFor(changeId);
    const existing = await this.get(appId, key);
    if (existing === null) {
      try {
        await cfRequest(
          this.opts,
          {
            method: "POST",
            path: this.path(appId),
            json: changeFlagDefinition(key, opts.enabled, opts.description),
          },
          z.unknown(),
        );
        return key;
      } catch (e) {
        if (!(e instanceof CfApiError && e.status === 409)) throw e;
        // Created concurrently: fall through and reconcile `enabled`.
      }
    }
    const current = existing ?? (await this.get(appId, key));
    if (current !== null && current.enabled !== opts.enabled)
      await this.put(appId, { ...current, enabled: opts.enabled });
    return key;
  }

  async setEnabled(appId: string, flagKey: string, enabled: boolean): Promise<void> {
    const current = await this.get(appId, flagKey);
    if (current === null) {
      // Turning off a flag that does not exist: create it disabled so the kill sticks.
      if (!enabled) {
        await cfRequest(
          this.opts,
          {
            method: "POST",
            path: this.path(appId),
            json: changeFlagDefinition(flagKey, false, "created disabled by the kill switch"),
          },
          z.unknown(),
        );
      }
      return;
    }
    if (current.enabled === enabled) return;
    await this.put(appId, { ...current, enabled });
  }
}
