import { describe, expect, it } from "vitest";
import { titleCase } from "../src/title.js";

describe("titleCase", () => {
  it("capitalizes every word", () => {
    expect(titleCase("hello world")).toBe("Hello World");
    expect(titleCase("  MIXED   case ")).toBe("Mixed Case");
  });
});
