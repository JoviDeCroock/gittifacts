import { describe, expect, it } from "vitest";
import { formatCents } from "../src/format.js";

describe("formatCents", () => {
  it("formats cents with the currency code", () => {
    expect(formatCents(1230)).toBe("12.30 EUR");
    expect(formatCents(5, "USD")).toBe("0.05 USD");
    expect(formatCents(-250)).toBe("-2.50 EUR");
  });

  it("groups thousands", () => {
    expect(formatCents(123456789)).toBe("1,234,567.89 EUR");
    expect(formatCents(-100000)).toBe("-1,000.00 EUR");
  });
});
