import { ChangeDiff, Evidence, Plan, PipelineRun, Repo, Tour, Change, AuditEvent, Principal, LinkedIssue } from "@app/domain";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/api/fixtures.js";
import { excerptForRef } from "../src/lib/diff.js";

const db = createDb();

describe("mock fixtures match the domain contract", () => {
  it("validates every repo, plan, principal and audit event", () => {
    for (const r of db.repos) expect(() => Repo.parse(r.repo)).not.toThrow();
    for (const p of db.plans) expect(() => Plan.parse(p)).not.toThrow();
    for (const p of db.principals) expect(() => Principal.parse(p)).not.toThrow();
    for (const e of db.audit) expect(() => AuditEvent.parse(e)).not.toThrow();
  });

  it("validates every change, diff, tour, evidence bundle, run and issue", () => {
    for (const s of db.scenarios) {
      const where = s.change.id;
      expect(Change.safeParse(s.change).success, where).toBe(true);
      expect(ChangeDiff.safeParse(s.diff).success, where).toBe(true);
      if (s.tour) expect(Tour.safeParse(s.tour).error?.issues ?? [], where).toEqual([]);
      if (s.evidence) expect(Evidence.safeParse(s.evidence).error?.issues ?? [], where).toEqual([]);
      for (const run of s.runs) expect(PipelineRun.safeParse(run).success, where).toBe(true);
      for (const issue of s.issues) expect(LinkedIssue.safeParse(issue).success, where).toBe(true);
    }
  });

  it("chains audit hashes", () => {
    db.audit.forEach((e, i) => {
      if (i > 0) expect(e.prevHash).toBe(db.audit[i - 1]?.hash);
    });
  });

  it("resolves every tour hunk ref and evidence ref", () => {
    for (const s of db.scenarios) {
      if (!s.tour) continue;
      const ids = new Set(s.evidence?.items.map((i) => i.id) ?? []);
      for (const stop of s.tour.stops) {
        for (const ref of stop.hunkRefs) {
          const ex = excerptForRef(s.diff, ref);
          expect(ex, `${s.change.id}: ${ref.file}`).not.toBeNull();
          expect(ex?.missing, `${s.change.id}: ${ref.file} ${ref.startLine}-${ref.endLine}`).toBe(false);
        }
        for (const id of stop.evidenceRefs) expect(ids.has(id), `${s.change.id}: ${id}`).toBe(true);
      }
    }
  });

  it("covers the nine canonical scenarios", () => {
    const by = (id: string) => db.scenarios.find((s) => s.change.id === id);
    expect(by("chg_tz7k2")?.evidence?.items.find((i) => i.kind === "red-green")).toMatchObject({ verdict: "proven" });
    expect(by("chg_lc3m9")?.evidence?.items.find((i) => i.kind === "red-green")).toMatchObject({ verdict: "no-tests" });
    expect(by("chg_pg5q1")?.evidence?.items.find((i) => i.kind === "public-api")).toMatchObject({ classification: "additive" });
    const breaking = by("chg_br8w4");
    expect(breaking?.evidence?.items.find((i) => i.kind === "public-api")).toMatchObject({ classification: "breaking" });
    expect(breaking?.tour?.stops.find((st) => st.kind === "risk")?.title).toContain("Breaking");
    expect(by("chg_pd2n6")?.evidence?.items.find((i) => i.kind === "dependencies")).toMatchObject({ newInstallScripts: [{ name: "sharp" }] });
    expect(by("chg_ss4h8")?.change.laneReasons.some((r) => r.code === "sensitive.path")).toBe(true);
    expect(by("chg_cm6t3")?.evidence?.items.find((i) => i.kind === "transform")).toMatchObject({ verified: true });
    expect(by("chg_pl9c2")?.change.laneReasons.some((r) => r.code === "policy.modified")).toBe(true);
    expect(by("chg_dr1x5")?.change.laneReasons.some((r) => r.code === "scope.drift")).toBe(true);
    expect(by("chg_fx2r7")?.change.rolloutState?.status).toBe("rolling");
    expect(by("chg_lg8b0")?.change.status).toBe("reverted");
  });
});
