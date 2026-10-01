import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("is valid JSON with all four scripts", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg.scripts).toEqual({
    build: "tsc -p .",
    test: "vitest run",
    lint: "biome check .",
    format: "biome format --write .",
  });
  expect(pkg.type).toBe("module");
});
