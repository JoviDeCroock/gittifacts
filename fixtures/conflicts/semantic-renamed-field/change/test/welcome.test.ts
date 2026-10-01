import { expect, it } from "vitest";
import { makeUser } from "../src/user.js";
import { welcome } from "../src/welcome.js";

it("welcomes returning users", () => {
  expect(welcome(makeUser(7, "Grace"))).toBe("Welcome back, Grace!");
});
