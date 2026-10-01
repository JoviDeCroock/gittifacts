import { expect, it } from "vitest";
import { permalink } from "../src/permalink.js";
import { slugify } from "../src/slug.js";

it("permalinks keep dashes while the default stays underscore", () => {
  expect(permalink("Hello World")).toBe("/posts/hello-world");
  expect(slugify("A B")).toBe("a_b");
});
