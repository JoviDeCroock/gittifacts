import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("has build and test scripts", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg.scripts.build).toBe("tsc -p .");
  expect(pkg.scripts.test).toBe("vitest run");
});
