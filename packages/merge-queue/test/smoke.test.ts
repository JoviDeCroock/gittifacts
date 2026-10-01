import { describe, expect, it } from "vitest";
import { World, affected } from "./harness.js";

describe("smoke", () => {
  it("lands independent and conflicting changes", () => {
    const w = new World();
    w.enqueue({ id: "a", affected: affected({ files: ["a.ts"], tests: ["ta"] }) });
    w.enqueue({ id: "b", affected: affected({ files: ["b.ts"], tests: ["tb"] }) });
    w.enqueue({ id: "c", affected: affected({ files: ["a.ts"], tests: ["ta"] }) });
    w.drain();
    expect(w.violations).toEqual([]);
    expect(new Set(w.merged)).toEqual(new Set(["a", "b", "c"]));
    expect(w.refs.size).toBe(0);
  });
  it("ejects a bad change and lands the rest", () => {
    const w = new World();
    for (const id of ["a", "b", "c", "d"]) w.enqueue({ id, affected: affected({ files: ["x.ts"], tests: ["tx"] }), bad: id === "c" });
    w.drain();
    expect(w.violations).toEqual([]);
    expect(new Set(w.merged)).toEqual(new Set(["a", "b", "d"]));
    expect(w.ejected.get("c")).toBe("tests-failed");
  });
});
