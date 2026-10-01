import { expect, it } from "vitest";
import { greet } from "../src/greet.js";

it("greets", () => {
  expect(greet("Bob")).toBe("Hello, Bob!");
});
