import { describe, expect, it } from "vitest";
import { slugify } from "../src/slug.js";

describe("slugify", () => {
  it("lowercases and joins words with dashes", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("Crème brûlée")).toBe("creme-brulee");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("  Hello, World!  ")).toBe("hello-world");
  });
});
