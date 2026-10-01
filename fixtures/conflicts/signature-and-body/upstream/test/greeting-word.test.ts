import { expect, it } from "vitest";
import { greet } from "../src/greet.js";

it("uses the given greeting", () => {
  expect(greet("Bob", "Hi")).toBe("Hi, Bob!");
});
