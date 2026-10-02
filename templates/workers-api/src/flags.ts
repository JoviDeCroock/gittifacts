/**
 * Kill-switch flags. Every merged Change gets a Flagship flag `change-<changeId>`: on while the
 * Change rolls out, switched off when the rollout regresses (or a human kills the Change). Guard
 * the new code path of a risky Change with it, so switching the flag off restores the old one:
 *
 *   if (await isChangeEnabled(env, "<your change id>")) return newBehaviour();
 *   return oldBehaviour();
 *
 * The platform binds `FLAGS` (the flags) and `VERSION` (this version's metadata) in every version
 * it deploys. Locally, in tests and in previews there is no `FLAGS`, so the Change counts as on
 * (it is part of the code); a flag that does not exist or fails to evaluate counts as on too.
 * A flip reaches every location within about 30 seconds.
 */

/** Flat evaluation context (e.g. `{ targetingKey: userId }`). */
export type FlagContext = Record<string, string | number | boolean>;

/** The part of the Flagship binding this helper uses. */
export interface FlagsBinding {
  getBooleanValue(flagKey: string, defaultValue: boolean, context?: FlagContext): Promise<boolean>;
}

export function changeFlagKey(changeId: string): string {
  return `change-${changeId}`;
}

export async function isChangeEnabled(
  env: { FLAGS?: FlagsBinding | undefined },
  changeId: string,
  context?: FlagContext,
): Promise<boolean> {
  if (env.FLAGS === undefined) return true;
  try {
    return await env.FLAGS.getBooleanValue(changeFlagKey(changeId), true, context);
  } catch {
    return true;
  }
}
