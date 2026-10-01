import { expect, it } from "vitest";
import { cartTotal } from "../src/cart.js";

it("applies a discount, never below zero", () => {
  expect(cartTotal([{ price: 2, qty: 3 }], 5)).toBe(1);
  expect(cartTotal([{ price: 2, qty: 3 }], 50)).toBe(0);
});
