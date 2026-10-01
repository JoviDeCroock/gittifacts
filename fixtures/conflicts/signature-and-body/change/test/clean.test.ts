import { expect, it } from "vitest";
import { greet } from "../src/greet.js";

it("cleans the name", () => {
  expect(greet("  ada ")).toBe("Hello, Ada!");
});
