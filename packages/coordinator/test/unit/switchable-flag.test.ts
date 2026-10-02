import type { ChangeDiff, DiffLine } from "@app/domain";
import { describe, expect, it } from "vitest";
import { switchableFlag } from "../../src/queue/enqueue.js";

const diff = (lines: Array<[DiffLine["kind"], string]>): ChangeDiff =>
  ({
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    additions: lines.filter(([k]) => k === "add").length,
    deletions: 0,
    files: [
      {
        path: "src/app.ts",
        hunks: [
          {
            header: "@@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: lines.length,
            lines: lines.map(([kind, text]) => ({ kind, oldNo: null, newNo: 1, text })),
          },
        ],
      },
    ],
  }) as unknown as ChangeDiff;

describe("switchableFlag", () => {
  const id = "k3j9abcdefghij012345";

  it("finds the flag key named in added code", () => {
    expect(switchableFlag(id, diff([["add", `flags.get("change-${id}")`]]))).toBe(`change-${id}`);
  });

  it("finds isChangeEnabled(env, <id>) across lines, with any quote style", () => {
    for (const q of ['"', "'", "`"]) {
      const d = diff([
        ["add", "  if (await isChangeEnabled("],
        ["add", "    env,"],
        ["add", `    ${q}${id}${q},`],
        ["add", "  )) {"],
      ]);
      expect(switchableFlag(id, d)).toBe(`change-${id}`);
    }
  });

  it("ignores removed or context lines, another Change's id and a bare mention", () => {
    expect(switchableFlag(id, diff([["del", `isChangeEnabled(env, "${id}")`]]))).toBeNull();
    expect(switchableFlag(id, diff([["ctx", `isChangeEnabled(env, "${id}")`]]))).toBeNull();
    expect(
      switchableFlag(id, diff([["add", 'isChangeEnabled(env, "other0123456789abcdef")']])),
    ).toBeNull();
    expect(switchableFlag(id, diff([["add", `// see ${id}`]]))).toBeNull();
    expect(switchableFlag(id, null)).toBeNull();
  });
});
