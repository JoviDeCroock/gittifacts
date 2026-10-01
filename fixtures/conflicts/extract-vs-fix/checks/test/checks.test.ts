import { expect, it } from "vitest";
import { register, validate } from "../src/signup.js";

it("validate and register agree on the stricter rule", () => {
  expect(register({ email: " Ada@Example.org ", age: 30 })).toBe("registered ada@example.org");
  expect(() => validate({ email: "a b@c.d", age: 30 })).toThrow("invalid email");
  expect(() => validate({ email: " Ada@Example.org ", age: 30 })).not.toThrow();
  expect(() => validate({ email: "a@b.co", age: 9 })).toThrow("too young");
  expect(() => register({ email: "a@b@c", age: 30 })).toThrow("invalid email");
});
