import { expect, it } from "vitest";
import { register } from "../src/signup.js";

it("normalizes and checks emails strictly", () => {
  expect(register({ email: " Ada@Example.org ", age: 30 })).toBe("registered ada@example.org");
  expect(() => register({ email: "a b@c.d", age: 30 })).toThrow("invalid email");
  expect(() => register({ email: "a@b@c", age: 30 })).toThrow("invalid email");
});
