import { expect, it } from "vitest";
import { nextId } from "../src/ids.js";
import { label, makeUser } from "../src/user.js";
import { welcome } from "../src/welcome.js";

it("welcome uses the renamed field; everything else still works", () => {
  expect(welcome(makeUser(7, "Grace"))).toBe("Welcome back, Grace!");
  expect(label(makeUser(1, "Ada"))).toBe("#1 Ada");
  expect(nextId([1])).toBe(2);
  expect(Object.keys(makeUser(1, "x")).sort()).toEqual(["displayName", "id"]);
});
