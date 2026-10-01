import { describe, expect, it } from "vitest";
import { priceLabel, priceResponse } from "../src/routes/price.js";

describe("price route", () => {
  it("labels prices", () => {
    expect(priceLabel(1999)).toBe("Price: 19.99 EUR");
  });

  it("clamps out-of-range prices", () => {
    expect(priceLabel(-100)).toBe("Price: 0.00 EUR");
    expect(priceLabel(1e12)).toBe("Price: 1000000.00 EUR");
  });

  it("responds with text", async () => {
    expect(await priceResponse(5).text()).toBe("Price: 0.05 EUR");
  });
});
