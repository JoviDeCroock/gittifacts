import { expect, it } from "vitest";
import { cartTotal } from "../src/cart.js";

it("adds up lines", () => {
  expect(cartTotal([{ price: 2, qty: 3 }, { price: 1, qty: 1 }])).toBe(7);
});
