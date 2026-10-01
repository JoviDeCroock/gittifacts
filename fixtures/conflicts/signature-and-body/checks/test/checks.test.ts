import { expect, it } from "vitest";
import { greet } from "../src/greet.js";

it("cleans names and honours the greeting word", () => {
  expect(greet("  ada ")).toBe("Hello, Ada!");
  expect(greet("bob", "Hi")).toBe("Hi, Bob!");
  expect(greet("Bob")).toBe("Hello, Bob!");
});
