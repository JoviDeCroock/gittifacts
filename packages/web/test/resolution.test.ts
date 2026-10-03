/** Reading a resolver's resolution: what each side had, what lands, and who wrote each line. */
import { type ComponentChildren, h } from "preact";
import prerender from "preact-iso/prerender";
import { describe, expect, it } from "vitest";
import { parseResolution as parseView } from "../src/api/resolution.js";
import { RESOLUTION_SCENARIOS } from "../src/api/scenarios-resolution.js";
import { ResolutionPanel } from "../src/components/ResolutionPanel.js";
import { parseResolution, resolverLineCount } from "../src/lib/resolution.js";

async function html(child: ComponentChildren): Promise<string> {
  return (await prerender(h("div", null, child))).html;
}

const diff = (...lines: string[]) => `${lines.join("\n")}\n`;

describe("parseResolution", () => {
  it("recovers both sides and tags the line the resolver wrote", () => {
    const files = parseResolution(
      diff(
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1,9 +1,3 @@",
        " # app",
        "-<<<<<<<<<<<<< upstream",
        "-See the docs.",
        "-||||||||||||| base",
        "-Docs.",
        "-=============",
        "-Docs: https://example.dev/docs",
        "->>>>>>>>>>>>> change",
        "+See the docs: https://example.dev/docs",
        " ## Install",
      ),
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("README.md");
    expect(files[0]?.outside).toEqual([]);
    expect(files[0]?.regions).toEqual([
      {
        upstream: ["See the docs."],
        base: ["Docs."],
        change: ["Docs: https://example.dev/docs"],
        lands: [{ text: "See the docs: https://example.dev/docs", origin: "resolver" }],
        hidden: 0,
      },
    ]);
    expect(resolverLineCount(files)).toBe(1);
  });

  it("kept lines land with their side; lines on both sides say so", () => {
    const [f] = parseResolution(
      diff(
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,7 +1,3 @@",
        "-<<<<<<< HEAD",
        " export const a = 1;",
        " export const shared = 0;",
        "-=======",
        "-export const shared = 0;",
        "-export const b = 2;",
        "->>>>>>> change",
        "+export const b = 2;",
      ),
    );
    expect(f?.regions[0]?.lands).toEqual([
      { text: "export const a = 1;", origin: "upstream" },
      { text: "export const shared = 0;", origin: "both" },
      { text: "export const b = 2;", origin: "change" },
    ]);
    expect(f?.regions[0]?.base).toBeNull();
  });

  it("lists edits outside any conflict region, and counts lines hidden between hunks", () => {
    const [f] = parseResolution(
      diff(
        "diff --git a/x.ts b/x.ts",
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -1,3 +1,3 @@",
        " a",
        "-b",
        "+B",
        "@@ -10,2 +10,1 @@",
        "-<<<<<<< upstream",
        " u1",
        "@@ -20,4 +12,1 @@",
        " u9",
        "-=======",
        "-c1",
        "->>>>>>> change",
      ),
    );
    expect(f?.outside).toEqual([
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
    ]);
    expect(f?.regions[0]?.upstream).toEqual(["u1", "u9"]);
    expect(f?.regions[0]?.hidden).toBe(8);
    expect(f?.regions[0]?.lands.map((l) => l.origin)).toEqual(["upstream", "upstream"]);
  });

  it("an empty or unparsable diff has no files", () => {
    expect(parseResolution("")).toEqual([]);
    expect(parseResolution("not a diff")).toEqual([]);
  });
});

describe("ResolutionPanel", () => {
  const r = RESOLUTION_SCENARIOS[0]?.resolution ?? null;

  it("the mock resolution is what the API validates", async () => {
    expect(await parseView(r)).toEqual(r);
    await expect(parseView({ ...r, headSha: 7 })).rejects.toThrow(/did not match/);
  });

  it("asks to approve the resolution and shows each side and the resolver's line", async () => {
    if (r === null) throw new Error("no mock resolution");
    const out = await html(h(ResolutionPanel, { r, awaiting: true }));
    expect(out).toContain("Approve the resolution, not only the diff");
    expect(out).toContain("the earlier approval no longer covers it");
    expect(out).toContain("Main had (chg_up3d8)");
    expect(out).toContain("This change had");
    expect(out).toContain("Lands on main");
    expect(out).toMatch(/res-line--resolver[^>]*>.*resolver<\/span><code class="res-text">Routes edge traffic\. Read the docs \(https/s);
    expect(out).toContain("1 line written by the resolver");
    expect(out).toContain("Only the conflict hunks changed");
  });

  it("after the decision it describes the resolution without asking", async () => {
    if (r === null) throw new Error("no mock resolution");
    const out = await html(h(ResolutionPanel, { r: { ...r, approvalRequested: false }, awaiting: false }));
    expect(out).toContain("The merge queue resolved a conflict in this change");
    expect(out).not.toContain("no longer covers");
  });
});
