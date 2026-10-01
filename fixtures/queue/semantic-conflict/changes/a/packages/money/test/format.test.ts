import { describe, expect, it } from "vitest";
import { formatCents } from "../src/format.js";

describe("formatCents", () => {
  it("formats cents with the currency symbol", () => {
    expect(formatCents(1230)).toBe("€12.30");
    expect(formatCents(5, "USD")).toBe("$0.05");
    expect(formatCents(-250)).toBe("-€2.50");
  });

  it("falls back to the currency code", () => {
    expect(formatCents(1230, "CHF")).toBe("12.30 CHF");
  });
});
