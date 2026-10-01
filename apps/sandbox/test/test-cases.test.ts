import { describe, expect, it } from "vitest";
import { allStaticTests, changedTestCases } from "../src/lib/test-cases.js";

const FILE = `import { describe, expect, it } from "vitest";
import { add } from "../src/add.js";

const helper = (n: number) => n * 2;

describe("add", () => {
  it("adds", () => {
    expect(add(1, 2)).toBe(3);
  });

  it("adds negatives", () => {
    expect(add(-1, -2)).toBe(-3);
  });

  describe("nested", () => {
    beforeEach(() => {});
    test("deep", () => {
      expect(helper(2)).toBe(4);
    });
  });

  it.skip("skipped", () => {});
  it.each([1, 2])("each %s", (n) => {
    expect(n).toBeGreaterThan(0);
  });
});
`;

describe("changedTestCases", () => {
  it("selects the test containing a changed line", () => {
    const r = changedTestCases("t.test.ts", FILE, [12]);
    expect(r).toEqual({
      kind: "tests",
      tests: [{ path: ["add", "adds negatives"], start: 11, end: 13 }],
    });
  });

  it("ignores import, blank and comment lines", () => {
    expect(changedTestCases("t.test.ts", FILE, [1, 2, 5])).toEqual({ kind: "tests", tests: [] });
  });

  it("widens to the whole suite for a change in shared suite code", () => {
    const r = changedTestCases("t.test.ts", FILE, [16]);
    expect(r).toEqual({
      kind: "tests",
      tests: [{ path: ["add", "nested", "deep"], start: 17, end: 19 }],
    });
  });

  it("falls back to the whole file for top-level helpers", () => {
    expect(changedTestCases("t.test.ts", FILE, [4]).kind).toBe("whole-file");
  });

  it("falls back to the whole file for a changed test with a dynamic title", () => {
    expect(changedTestCases("t.test.ts", FILE, [24]).kind).toBe("whole-file");
  });

  it("never selects skipped tests", () => {
    expect(changedTestCases("t.test.ts", FILE, [22])).toEqual({ kind: "tests", tests: [] });
  });

  it("selects a suite's tests when its header line changes (new describe block)", () => {
    const r = changedTestCases("t.test.ts", FILE, [15]);
    expect(r.kind === "tests" && r.tests.map((t) => t.path.join(" > "))).toEqual([
      "add > nested > deep",
    ]);
  });
});

describe("allStaticTests", () => {
  it("is null when a title is dynamic", () => {
    expect(allStaticTests("t.test.ts", FILE)).toBeNull();
  });

  it("lists every runnable test", () => {
    const text = `describe("a", () => { it("x", () => {}); it.todo("y"); test("z", () => {}); });`;
    expect(allStaticTests("t.test.ts", text)?.map((t) => t.path.join(" > "))).toEqual([
      "a > x",
      "a > z",
    ]);
  });
});
