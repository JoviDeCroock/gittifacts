import { describe, expect, it } from "vitest";
import { priceLabel, priceResponse } from "../src/routes/price.js";

describe("price route", () => {
  it("labels prices", () => {
    expect(priceLabel(1999)).toBe("Price: €19.99");
  });

  it("responds with text", async () => {
    expect(await priceResponse(5).text()).toBe("Price: €0.05");
  });
});
