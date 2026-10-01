import { describe, expect, it } from "vitest";
import { truncate } from "../src/index.js";

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  it("cuts long text and appends an ellipsis within maxLength", () => {
    const out = truncate("The quick brown fox", 10);
    expect(out).toBe("The quick…");
    expect(Array.from(out)).toHaveLength(10);
  });

  it("supports a custom ellipsis", () => {
    expect(truncate("abcdefghij", 6, { ellipsis: "..." })).toBe("abc...");
  });

  it("counts characters, not UTF-16 code units", () => {
    expect(truncate("😀😀😀😀", 3)).toBe("😀😀…");
  });

  it("rejects a negative maxLength", () => {
    expect(() => truncate("x", -1)).toThrow(RangeError);
  });
});
