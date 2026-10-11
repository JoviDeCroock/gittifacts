import { describe, expect, it } from "vitest";
import { proseBlocks } from "../src/lib/prose.js";

describe("proseBlocks", () => {
  it("keeps a plan intent's lead line, its list and the paragraph after it apart", () => {
    const intent =
      "Detection found:\n- Package manager: pnpm\n- Install: `pnpm install`\n\nThis Change proposes .platform/ci.ts.\nNothing is applied until a human approves it.";
    expect(proseBlocks(intent)).toEqual([
      { kind: "p", lines: ["Detection found:"] },
      { kind: "ul", items: ["Package manager: pnpm", "Install: `pnpm install`"] },
      {
        kind: "p",
        lines: [
          "This Change proposes .platform/ci.ts.",
          "Nothing is applied until a human approves it.",
        ],
      },
    ]);
  });

  it("treats one-line text as one paragraph", () => {
    expect(proseBlocks("Cut FX lookups to one per minute.")).toEqual([
      { kind: "p", lines: ["Cut FX lookups to one per minute."] },
    ]);
  });
});
