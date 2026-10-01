import { expect, it } from "vitest";
import { register } from "../src/signup.js";

it("registers adults with an email", () => {
  expect(register({ email: "a@b.co", age: 20 })).toBe("registered a@b.co");
  expect(() => register({ email: "nope", age: 20 })).toThrow("invalid email");
  expect(() => register({ email: "a@b.co", age: 9 })).toThrow("too young");
});
