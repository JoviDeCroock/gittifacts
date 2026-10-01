import { describe, expect, it } from "vitest";
import {
  CONVENTIONS_MARKER,
  CONVENTIONS_VERSION,
  conventionsVersionOf,
  isOutdated,
} from "../src/index.js";

describe("conventions marker", () => {
  it("is an HTML comment with the version", () => {
    expect(CONVENTIONS_MARKER).toBe(`<!-- gittifacts-conventions v${CONVENTIONS_VERSION} -->`);
    expect(conventionsVersionOf(`${CONVENTIONS_MARKER}\n# x`)).toBe(CONVENTIONS_VERSION);
  });

  it("flags missing and older markers, not newer ones", () => {
    expect(isOutdated("# hand-written AGENTS.md")).toBe(true);
    expect(isOutdated("<!-- gittifacts-conventions v0 -->")).toBe(true);
    expect(isOutdated(CONVENTIONS_MARKER)).toBe(false);
    expect(isOutdated(`<!--gittifacts-conventions v${CONVENTIONS_VERSION + 1}-->`)).toBe(false);
  });
});
