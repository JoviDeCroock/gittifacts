/**
 * The kill switch for unclaimed creation (onboarding §4: "a kill switch that stops all unclaimed
 * creation instantly").
 *
 * 1. The Flagship flag `unclaimed-creation-enabled` (FLAGS binding), fail closed: a missing
 *    binding, an unknown flag, a non-boolean value or an evaluation error all read as OFF.
 * 2. An admin override in D1 (`platform_settings["unclaimed-creation"]` = "on" | "off"), set by a
 *    human platform admin through `PUT /api/v1/admin/unclaimed-creation`, which works when
 *    Flagship is unreachable. "off" always wins; "on" only bridges an unevaluable flag (a flag
 *    explicitly set to false still stops creation).
 *
 * When off, credential-less create_project answers 503 `creation-disabled` with a fix that says
 * how to authenticate. Authenticated callers are never affected.
 */
import { eq } from "drizzle-orm";
import { platformSettings } from "../db/schema.js";
import type { D1Store } from "../store/d1-store.js";

export const UNCLAIMED_CREATION_FLAG = "unclaimed-creation-enabled";
export const UNCLAIMED_CREATION_SETTING = "unclaimed-creation";

export type CreationOverride = "on" | "off";

export interface CreationState {
  enabled: boolean;
  /** Why: the admin override, the flag, or the flag failing (closed). */
  source: "override" | "flag" | "flag-unavailable";
  override: CreationOverride | null;
  /** The flag's value, or null when it could not be evaluated. */
  flag: boolean | null;
  detail: string | null;
}

/** The slice of the Flagship binding this module needs (tests pass their own). */
export interface FlagReader {
  getBooleanDetails(
    key: string,
    defaultValue: boolean,
  ): Promise<{ value: boolean; errorCode?: string | undefined; reason?: string | undefined }>;
}

export async function readOverride(store: D1Store): Promise<CreationOverride | null> {
  const row = await store.db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, UNCLAIMED_CREATION_SETTING))
    .get();
  return row?.value === "on" || row?.value === "off" ? row.value : null;
}

export async function writeOverride(
  store: D1Store,
  value: CreationOverride | null,
  by: string,
  now: Date,
): Promise<void> {
  if (value === null) {
    await store.db
      .delete(platformSettings)
      .where(eq(platformSettings.key, UNCLAIMED_CREATION_SETTING));
    return;
  }
  await store.db
    .insert(platformSettings)
    .values({ key: UNCLAIMED_CREATION_SETTING, value, updatedAt: now.toISOString(), updatedBy: by })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value, updatedAt: now.toISOString(), updatedBy: by },
    });
}

async function evaluateFlag(flags: FlagReader | undefined): Promise<{
  value: boolean | null;
  detail: string | null;
}> {
  if (flags === undefined || typeof flags.getBooleanDetails !== "function") {
    return { value: null, detail: "no FLAGS binding" };
  }
  try {
    const d = await flags.getBooleanDetails(UNCLAIMED_CREATION_FLAG, false);
    if (d.errorCode !== undefined || d.reason === "ERROR") {
      return { value: null, detail: `flag evaluation failed: ${d.errorCode ?? d.reason}` };
    }
    return { value: d.value === true, detail: d.reason ?? null };
  } catch (e) {
    return { value: null, detail: `flag evaluation failed: ${String(e)}` };
  }
}

export async function unclaimedCreationState(
  store: D1Store,
  flags: FlagReader | undefined,
): Promise<CreationState> {
  let override: CreationOverride | null = null;
  try {
    override = await readOverride(store);
  } catch (e) {
    // D1 down: fall through to the flag (which also fails closed).
    console.error("kill switch: could not read the admin override", e);
  }
  const flag = await evaluateFlag(flags);
  // Off always wins: the override "off" and the flag set to false each stop creation on their
  // own. The override "on" only bridges a Flagship that can't be evaluated (an admin's choice).
  if (override === "off") return { enabled: false, source: "override", override, ...rest(flag) };
  if (flag.value !== null) return { enabled: flag.value, source: "flag", override, ...rest(flag) };
  if (override === "on") return { enabled: true, source: "override", override, ...rest(flag) };
  return { enabled: false, source: "flag-unavailable", override, ...rest(flag) };
}

function rest(flag: { value: boolean | null; detail: string | null }) {
  return { flag: flag.value, detail: flag.detail };
}
