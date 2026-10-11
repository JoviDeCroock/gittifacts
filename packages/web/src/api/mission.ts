/**
 * Mission control's data: the repo's changes and its merge queue from the existing endpoints
 * (`GET /api/v1/repos/:repoId/changes`, `GET /api/v1/repos/:repoId/queue`), plus each agent's
 * accountable person (`GET /api/v1/principals/:id`, cached: owners don't change). No aggregate
 * endpoint: the page polls these like the queue view does.
 *
 * The queue is optional (a repo the queue doesn't know, an older server): mission control then
 * shows every change by its own status and says the queue is unavailable.
 */
import { api } from "./client.js";
import { isMockMode } from "./mode.js";
import { fetchQueueOverview, type QueueOverviewView } from "./queue.js";
import type { ChangeSummary } from "./types.js";

export interface MissionData {
  repoId: string;
  changes: ChangeSummary[];
  queue: QueueOverviewView | null;
  /** Why the queue is missing, when it is. */
  queueError: unknown;
  owners: Record<string, string | null>;
}

/** How often the page refreshes: the real API like the queue view; the demo faster, it's local. */
export const MISSION_POLL_MS = 10_000;
export const MISSION_MOCK_POLL_MS = 2_000;

const ownerCache = new Map<string, Promise<string | null>>();

function ownerOf(id: string): Promise<string | null> {
  let hit = ownerCache.get(id);
  if (!hit) {
    hit = api.principal(id).then(
      (r) => r.principal.ownerName ?? null,
      () => {
        ownerCache.delete(id);
        return null;
      },
    );
    ownerCache.set(id, hit);
  }
  return hit;
}

export async function fetchMission(repoId: string): Promise<MissionData> {
  const [changes, queue] = await Promise.all([
    api.changes(repoId),
    fetchQueueOverview(repoId).then(
      (q) => ({ q, error: null as unknown }),
      (error: unknown) => ({ q: null, error }),
    ),
  ]);
  const agents = [
    ...new Set(changes.changes.filter((c) => c.authorKind === "agent").map((c) => c.authorId)),
  ];
  const names = await Promise.all(agents.map(ownerOf));
  const data: MissionData = {
    repoId,
    changes: changes.changes,
    queue: queue.q,
    queueError: queue.error,
    owners: Object.fromEntries(agents.map((id, i) => [id, names[i] ?? null])),
  };
  if (!isMockMode()) return data;
  // Demo data plays a short script so the board moves on camera (`?still` holds it at the start).
  const { playMissionScript } = await import("./mock-mission.js");
  return playMissionScript(data);
}
