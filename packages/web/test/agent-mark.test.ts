import { describe, expect, it } from "vitest";
import { markGlyph, markVariant } from "../src/components/AgentMark.js";

describe("markGlyph", () => {
  it("keeps numbered agents apart: first letter plus the number", () => {
    expect(markGlyph("fleet-coder-12")).toBe("F12");
    expect(markGlyph("fleet-coder-07")).toBe("F07");
    expect(markGlyph("planner-02")).toBe("P02");
  });

  it("never prints a severity code like P0", () => {
    for (const name of ["planner-0", "planner-02", "p0", "planner_1"])
      expect(markGlyph(name)).not.toMatch(/^P\d$/);
  });

  it("uses two initials for names without a number", () => {
    expect(markGlyph("Quill Agent")).toBe("QA");
    expect(markGlyph("issue-triager")).toBe("IT");
    expect(markGlyph("gittifacts CLI")).toBe("GC");
  });
});

describe("markVariant", () => {
  it("is stable and in range", () => {
    expect(markVariant("prn_coder07")).toBe(markVariant("prn_coder07"));
    for (const id of ["a", "b", "prn_x", "ag_quill_old"])
      expect([0, 1, 2, 3]).toContain(markVariant(id));
  });
});
