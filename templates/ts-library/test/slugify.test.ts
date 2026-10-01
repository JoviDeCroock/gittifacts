import { describe, expect, it } from "vitest";
import { slugify } from "../src/index.js";

describe("slugify", () => {
  it.each([
    ["Hello, World!", "hello-world"],
    ["  Crème brûlée  ", "creme-brulee"],
    ["already-a-slug", "already-a-slug"],
    ["Ünïcödé 123", "unicode-123"],
    ["", ""],
    ["!!!", ""],
  ])("%j → %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("uses a custom separator", () => {
    expect(slugify("a b c", { separator: "_" })).toBe("a_b_c");
  });

  it("cuts at a word boundary when maxLength is set", () => {
    expect(slugify("the quick brown fox", { maxLength: 12 })).toBe("the-quick");
  });

  it("cuts mid-word when there is no boundary", () => {
    expect(slugify("supercalifragilistic", { maxLength: 5 })).toBe("super");
  });
});
