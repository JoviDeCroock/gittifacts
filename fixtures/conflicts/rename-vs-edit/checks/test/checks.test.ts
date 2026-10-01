import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { cartTotal } from "../src/cart.js";

it("keeps the discount and the rename", () => {
  expect(cartTotal([{ price: 2, qty: 3 }, { price: 1, qty: 1 }])).toBe(7);
  expect(cartTotal([{ price: 2, qty: 3 }], 5)).toBe(1);
  const source = readFileSync(new URL("../src/cart.ts", import.meta.url), "utf8");
  expect(source).not.toContain("lineTotal");
});
