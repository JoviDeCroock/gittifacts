import { describe, expect, it } from "vitest";
import { invoiceLines } from "../src/routes/invoice.js";

describe("invoiceLines", () => {
  it("lists items and the total", () => {
    // Relies on formatCents' "12.30 EUR" format.
    expect(
      invoiceLines([
        { description: "Coffee", cents: 350 },
        { description: "Cake", cents: 425 },
      ]),
    ).toEqual(["Coffee: 3.50 EUR", "Cake: 4.25 EUR", "Total: 7.75 EUR"]);
  });
});
