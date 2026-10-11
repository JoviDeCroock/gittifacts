/**
 * The words people and agents see for a lane, shared by every surface (web app, CLI, `/start`,
 * MCP descriptions, GitHub text). The lane's name comes first; the numeral is a badge
 * ("Quick review (Lane 1)"). Machine names (`lane: 0 | 1 | 2`, reason codes, the
 * `gittifacts/lane` check) never change. Decided 2026-10-04 (DECISIONS: user-facing terms).
 */
import type { Lane } from "./model.js"; // type-only: this file stays free of zod for the web bundle

export interface LaneLabel {
  lane: Lane;
  /** "Auto-merge", "Quick review", "Full review". */
  name: string;
  /** "Lane 0": the badge shown next to the name. */
  badge: string;
  /** One line: what a person does in this lane. */
  description: string;
}

export const LANE_LABELS: Record<Lane, LaneLabel> = {
  0: {
    lane: 0,
    name: "Auto-merge",
    badge: "Lane 0",
    description: "The evidence decides; nobody reviews.",
  },
  1: {
    lane: 1,
    name: "Quick review",
    badge: "Lane 1",
    description: "A person reads the walkthrough and approves, usually in under three minutes.",
  },
  2: {
    lane: 2,
    name: "Full review",
    badge: "Lane 2",
    description: "A person reads the diff, with the walkthrough as a guide.",
  },
};

/** "Quick review (Lane 1)". */
export function laneLabel(lane: Lane): string {
  const l = LANE_LABELS[lane];
  return `${l.name} (${l.badge})`;
}
