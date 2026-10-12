import { describe, expect, it } from "vitest";
import { pageUrl } from "../src/urls.js";

describe("pageUrl: a repo's code and history", () => {
  const o = "https://gf.example";
  it("names directories, files, commits and activity, with a ref only when given", () => {
    expect(pageUrl(o, { repoId: "r1", code: { kind: "tree", path: "" } })).toBe(
      "https://gf.example/repos/r1/tree",
    );
    expect(pageUrl(o, { repoId: "r1", code: { kind: "tree", path: "src/lib/" } })).toBe(
      "https://gf.example/repos/r1/tree/src/lib",
    );
    expect(
      pageUrl(o, { repoId: "r1", code: { kind: "blob", path: "src/a b#.ts", ref: "v1.0" } }),
    ).toBe("https://gf.example/repos/r1/blob/src/a%20b%23.ts?ref=v1.0");
    expect(pageUrl(o, { repoId: "r1", commits: {} })).toBe("https://gf.example/repos/r1/commits");
    expect(pageUrl(o, { repoId: "r1", commits: { sha: "a".repeat(40) } })).toBe(
      `https://gf.example/repos/r1/commits/${"a".repeat(40)}`,
    );
    expect(pageUrl(o, { repoId: "r1", activity: { ref: "dev" } })).toBe(
      "https://gf.example/repos/r1/activity?ref=dev",
    );
  });
});
