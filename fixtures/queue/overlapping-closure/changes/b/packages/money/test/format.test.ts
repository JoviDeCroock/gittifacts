import { describe, expect, it } from "vitest";
import { formatCents } from "../src/format.js";

describe("formatCents", () => {
  it("formats cents with the currency code", () => {
    expect(formatCents(1230)).toBe("12.30 EUR");
    expect(formatCents(5, "USD")).toBe("0.05 USD");
  });

  it("puts negative amounts in parentheses", () => {
    expect(formatCents(-250)).toBe("(2.50) EUR");
  });
});
