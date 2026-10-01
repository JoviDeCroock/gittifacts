import { expect, it } from "vitest";
import { validate } from "../src/signup.js";

it("validates", () => {
  expect(() => validate({ email: "a@b.co", age: 20 })).not.toThrow();
  expect(() => validate({ email: "x", age: 20 })).toThrow("invalid email");
});
