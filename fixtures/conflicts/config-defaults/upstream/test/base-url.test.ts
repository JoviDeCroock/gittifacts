import { expect, it } from "vitest";
import { defaults } from "../src/config.js";

it("has a base URL and a 5 s timeout", () => {
  expect(defaults.baseUrl).toBe("https://api.example.com");
  expect(defaults.timeoutMs).toBe(5000);
});
