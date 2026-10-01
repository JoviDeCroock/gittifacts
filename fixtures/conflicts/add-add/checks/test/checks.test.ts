import { expect, it } from "vitest";
import { endpoint } from "../src/client.js";
import * as constants from "../src/constants.js";
import { page } from "../src/pager.js";

it("keeps every constant", () => {
  expect(constants).toMatchObject({ MAX_RETRIES: 5, API_VERSION: "v2", PAGE_SIZE: 50 });
  expect(endpoint("x")).toBe("/api/v2/x");
  expect(page([1, 2, 3], 0)).toEqual([1, 2, 3]);
});
