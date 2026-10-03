/**
 * Re-approving a resolver resolution (journey 06): the person sees the resolution itself, not the
 * agent's original tour. `GET /changes/:id/resolution` names the resolved head, the
 * conflict-resolution item (its diff), the upstream Changes and whether a fresh approval is
 * needed; `GET /changes/:id/tour` serves the resolved head's tour (it leads with the resolution).
 */
import { env } from "cloudflare:workers";
import { conflictResolutionItem } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { DoAudit } from "../src/audit/audit.js";
import {
  addMember,
  changeFixture,
  evidenceFixture,
  HEAD_SHA,
  seedWorld,
  store,
  tourFixture,
} from "./fixtures.js";
import { call, createAgent, json, makeApp, signUpHuman } from "./http.js";

const RESOLVED = "e".repeat(40);
const ONTO = "f".repeat(40);
const DIFF = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,7 +1,1 @@",
  "-<<<<<<<<<<<<< upstream",
  "-See the docs.",
  "-||||||||||||| base",
  "-Docs.",
  "-=============",
  "-Docs: https://example.dev/docs",
  "->>>>>>>>>>>>> change",
  "+See the docs: https://example.dev/docs",
  "",
].join("\n");

async function world() {
  const { app } = makeApp();
  const human = await signUpHuman(app);
  const agent = await createAgent(app, human.cookie);
  const s = store();
  const seeded = await seedWorld(s);
  await addMember(s, seeded.repo.id, human.principal.id, "owner");
  return { ...seeded, app, agent, s };
}

describe("GET /api/v1/changes/:id/resolution", () => {
  it("is null without a resolution, then names what lands and leads the tour with it", async () => {
    const { app, agent, s, change, repo } = await world();
    const get = async <T>(path: string) =>
      json<T>(
        await call(app, "GET", `/api/v1/changes/${change.id}/${path}`, { token: agent.token }),
      );
    expect(await get("resolution")).toEqual({ resolution: null });

    const upstream = changeFixture(repo.id, change.authorId, {
      title: "README: shorter intro",
      mergedSha: ONTO,
      status: "merged",
    });
    await s.insertChange(upstream);
    const original = tourFixture(change.id);
    await s.putTour(original);
    const item = conflictResolutionItem({
      upstreamChanges: [{ changeId: upstream.id, sha: ONTO }],
      ontoSha: ONTO,
      scope: {
        conflictHunks: [{ file: "README.md", startLine: 1, endLine: 1 }],
        touchesOutsideConflictHunks: false,
        novelLines: 1,
      },
      resolutionDiff: DIFF,
      semanticConflictWith: null,
      rationale: "Kept upstream's wording and the change's link.",
      resolver: { model: "m", principalId: "system:resolver", promptVersion: "v" },
      attempts: 1,
    });
    const ev = await evidenceFixture(change.id, RESOLVED);
    await s.putEvidence({ ...ev, items: [...ev.items, item] });
    const audit = new DoAudit(env);
    const subject = `change:${change.id}`;
    await audit.append({
      principalId: "system:merge-queue",
      action: "merge-queue.resolution",
      subject,
      payload: {
        attempt: 1,
        kind: "textual",
        status: "resolved",
        headSha: HEAD_SHA,
        newHead: RESOLVED,
      },
    });
    await audit.append({
      principalId: "system:merge-queue",
      action: "merge-queue.approval-requested",
      subject,
      payload: { lane: 1, reasons: ["merge-queue.resolution-novel-lines"] },
    });
    const resolved = tourFixture(change.id, { headSha: RESOLVED });
    await s.putTour(resolved);
    await s.updateChange(change.id, { tourId: resolved.id });

    const r = await get<{
      resolution: Record<string, unknown> & { item: { resolutionDiff: string } };
    }>("resolution");
    expect(r.resolution).toMatchObject({
      headSha: RESOLVED,
      originalHeadSha: HEAD_SHA,
      resolvedFrom: HEAD_SHA,
      ontoSha: ONTO,
      kind: "textual",
      approvalRequested: true,
      lane: 1,
      reasons: ["merge-queue.resolution-novel-lines"],
      tourId: resolved.id,
      upstream: [{ changeId: upstream.id, title: "README: shorter intro", sha: ONTO }],
    });
    expect(r.resolution.item.resolutionDiff).toBe(DIFF);
    // The resolved head's tour wins over the pushed head's (and is not "stale").
    expect(await get("tour")).toMatchObject({ tour: { id: resolved.id }, stale: false });

    // Pushed again: that resolution described an older head (the queue dequeued the Change).
    await s.updateChange(change.id, { headSha: "c".repeat(40) });
    expect(await get("resolution")).toEqual({ resolution: null });
  });
});
