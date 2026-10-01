import { expect, it } from "vitest";
import { label, makeUser } from "../src/user.js";

it("labels users", () => {
  expect(label(makeUser(1, "Ada"))).toBe("#1 Ada");
});
