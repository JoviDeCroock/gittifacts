/**
 * What a host can do. The core reads these and degrades explicitly: a capability a host lacks
 * changes what the platform does, and the change is recorded as a `Degradation` in the verdict
 * (never silent).
 */

/** Who can author or review a change on a host. Native `system`/`integration` principals are bots. */
export type IdentityKind = "human" | "agent" | "bot";

export interface HostCapabilities {
  /** The platform may merge a change itself (native: always; GitHub: opt-in contents:write). */
  canMerge: boolean;
  /** The platform may push commits to the change's branch (resolver commits). */
  canPushToChangeBranch: boolean;
  /** The platform runs its own merge queue on this host (native only in v1). */
  hasOwnMergeQueue: boolean;
  /** The host has a merge queue the platform plugs into as a required check (`merge_group`). */
  hasHostMergeQueue: boolean;
  /** Evidence can be written as git notes on the host (`refs/notes/evidence`). */
  supportsNotes: boolean;
  /** Tour stops can be anchored inline on the host's diff view. */
  supportsInlineTourStops: boolean;
  /** Identity kinds the host can tell apart. */
  identityKinds: readonly IdentityKind[];
}

/** One capability-driven change of behaviour, carried in the verdict so it is always visible. */
export interface Degradation {
  capability: Exclude<keyof HostCapabilities, "identityKinds">;
  /** What the platform would have done with the capability. */
  wanted: string;
  /** What it did instead. */
  instead: string;
  /** Human-readable, shown wherever the verdict is shown. */
  message: string;
}

export type LaneZeroAction = "merge" | "label-ready";

/**
 * What a Lane 0 change that may merge without a human becomes on this host: merged by the
 * platform, or (without `canMerge`) labelled "ready to merge", with the degradation recorded.
 */
export function laneZeroAction(caps: Pick<HostCapabilities, "canMerge">): {
  action: LaneZeroAction;
  degradation: Degradation | null;
} {
  if (caps.canMerge) return { action: "merge", degradation: null };
  return {
    action: "label-ready",
    degradation: {
      capability: "canMerge",
      wanted: "merge",
      instead: "label-ready",
      message:
        "Lane 0: the platform may not merge on this host, so the change is labelled ready to merge instead.",
    },
  };
}

/** Evidence is stored by the platform either way; without notes it is linked, not written to git. */
export function evidenceNoteDegradation(
  caps: Pick<HostCapabilities, "supportsNotes">,
): Degradation | null {
  if (caps.supportsNotes) return null;
  return {
    capability: "supportsNotes",
    wanted: "git-note",
    instead: "linked",
    message:
      "Evidence is signed and stored by the platform and linked from the host; it is not written as a git note.",
  };
}

/** The native host (Artifacts): every capability the platform has. */
export const NATIVE_CAPABILITIES: HostCapabilities = Object.freeze({
  canMerge: true,
  canPushToChangeBranch: true,
  hasOwnMergeQueue: true,
  hasHostMergeQueue: false,
  supportsNotes: true,
  supportsInlineTourStops: true,
  identityKinds: Object.freeze(["human", "agent", "bot"] as const),
});
