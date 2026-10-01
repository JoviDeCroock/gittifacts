/**
 * Kill-switch helper for user code. Every merged change gets a Flagship flag `change-<id>` that is
 * ON during rollout and turned OFF when the rollout regresses or a human hits the kill switch.
 * Guard the new code path with it:
 *
 *   import { isChangeEnabled } from "@app/coordinator/flags";
 *
 *   if (await isChangeEnabled(env.FLAGS, "k3j9…", { targetingKey: userId })) {
 *     return newBehaviour();
 *   }
 *   return oldBehaviour();
 *
 * Semantics: a flag that does not exist (yet, or any more) evaluates to `true` — the change is
 * simply part of the code. A disabled flag serves its `off` variation (`false`). Evaluation errors
 * also return `true`: the flag is a kill switch, not a gate, and Flagship itself returns the
 * default on errors. Flag flips take up to ~30 s to propagate.
 */

/** Flat evaluation context (Flagship rejects nested values). */
export type FlagContext = Record<string, string | number | boolean>;

/** The slice of the Flagship binding (`flagship: [{ binding, app_id }]`) this helper needs. */
export interface FlagshipLike {
  getBooleanValue(flagKey: string, defaultValue: boolean, context?: FlagContext): Promise<boolean>;
}

export function changeFlagKey(changeId: string): string {
  return `change-${changeId}`;
}

export async function isChangeEnabled(flags: FlagshipLike, changeId: string, context?: FlagContext): Promise<boolean> {
  try {
    return await flags.getBooleanValue(changeFlagKey(changeId), true, context);
  } catch {
    return true;
  }
}

/** Bind once: `const changes = changeFlags(env.FLAGS); await changes.isChangeEnabled(id)`. */
export function changeFlags(flags: FlagshipLike): {
  isChangeEnabled(changeId: string, context?: FlagContext): Promise<boolean>;
} {
  return { isChangeEnabled: (changeId, context) => isChangeEnabled(flags, changeId, context) };
}
