import { describe, expect, it } from "vitest";
import type { AuditPage } from "../src/api/types.js";
import { fleetFrom, subjectHref, WINDOW_MS, WORKING_MS } from "../src/lib/fleet.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
let seq = 0;
const ev = (principalId: string, action: string, msAgo: number, subject = "change:c1") => ({
  seq: ++seq,
  at: at(msAgo),
  principalId,
  action,
  subject,
  payloadHash: "h",
  prevHash: "p",
  hash: "x",
  signature: "s",
  keyId: "k",
});
const page = (events: ReturnType<typeof ev>[]): AuditPage => ({
  events,
  nextCursor: null,
  chain: { verified: true },
  principals: {
    a1: { id: "a1", kind: "agent", name: "coder-1", ownerId: "h1", ownerName: "Dev" },
    a2: { id: "a2", kind: "agent", name: "coder-2", ownerId: "h1" },
    a3: { id: "a3", kind: "agent", name: "coder-3", ownerId: "h1" },
    h1: { id: "h1", kind: "human", name: "Dev", ownerId: null },
  },
});

describe("fleetFrom", () => {
  it("one row per agent, its latest event, people left out", () => {
    const rows = fleetFrom(
      page([
        ev("a1", "change.pushed", 60_000),
        ev("a1", "change.review-requested", 30_000),
        ev("h1", "change.approved", 10_000),
      ]),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.last.action).toBe("change.review-requested");
    expect(rows[0]?.events).toBe(2);
    expect(rows[0]?.state).toBe("waiting");
  });

  it("orders waiting on a person, failing, working, quiet", () => {
    const rows = fleetFrom(
      page([
        ev("a1", "change.pushed", WORKING_MS + 60_000),
        ev("a2", "change.ci-failed", 120_000),
        ev("a3", "plan.created", 5 * 60_000, "plan:p1"),
      ]),
      NOW,
    );
    expect(rows.map((r) => [r.agent.id, r.state])).toEqual([
      ["a3", "waiting"],
      ["a2", "failing"],
      ["a1", "quiet"],
    ]);
    expect(rows[0]?.last.href).toBe("/plans/p1");
  });

  it("an event in the last 15 minutes is working; past the window the agent isn't listed", () => {
    expect(fleetFrom(page([ev("a1", "change.pushed", WORKING_MS - 1000)]), NOW)[0]?.state).toBe(
      "working",
    );
    expect(fleetFrom(page([ev("a1", "change.pushed", WINDOW_MS + 1000)]), NOW)).toEqual([]);
  });

  it("links subjects that have a screen", () => {
    expect(subjectHref("change:a b")).toBe("/changes/a%20b");
    expect(subjectHref("repo:r1")).toBe("/repos/r1");
    expect(subjectHref("principal:x")).toBeNull();
    expect(subjectHref("nothing")).toBeNull();
  });
});
