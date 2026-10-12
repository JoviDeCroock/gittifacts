import { describe, expect, it } from "vitest";
import { inline, markdownBlocks } from "../src/lib/markdown.js";

describe("markdown (READMEs)", () => {
  it("parses headings, paragraphs, lists, fences, quotes and rules", () => {
    const md = [
      "# Billing",
      "",
      "Splits the bill",
      "fairly.",
      "",
      "- one",
      "- two",
      "1. first",
      "```ts",
      "const a = 1;",
      "```",
      "> note",
      "---",
    ].join("\n");
    expect(markdownBlocks(md).map((b) => b.kind)).toEqual([
      "heading",
      "p",
      "ul",
      "ol",
      "code",
      "quote",
      "hr",
    ]);
    expect(markdownBlocks(md)[1]).toEqual({
      kind: "p",
      text: [{ kind: "text", text: "Splits the bill fairly." }],
    });
    expect(markdownBlocks(md)[4]).toEqual({ kind: "code", lang: "ts", text: "const a = 1;" });
  });

  it("links only http(s); images and other links stay text; HTML is text", () => {
    expect(
      inline("see [docs](https://x.dev) and [here](./a.md) ![logo](l.png) `x` **b** <b>"),
    ).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "docs", href: "https://x.dev" },
      { kind: "text", text: " and " },
      { kind: "text", text: "here" },
      { kind: "text", text: " " },
      { kind: "text", text: "logo" },
      { kind: "text", text: " " },
      { kind: "code", text: "x" },
      { kind: "text", text: " " },
      { kind: "strong", text: "b" },
      { kind: "text", text: " <b>" },
    ]);
    expect(inline("[x](javascript:alert(1))")[0]).toMatchObject({ kind: "text" });
  });
});
