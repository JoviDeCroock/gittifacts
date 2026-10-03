import { describe, expect, it } from "vitest";
import { gitNoteLine } from "../src/lib/evidence-note.js";

const HEAD = "19c18b61ebbd4f0e9d7c2a1b3c4d5e6f7a8b9c0d";
const MERGED = "aa11bb22cc33dd44ee55ff6600112233445566ff";

describe("gitNoteLine", () => {
  it("a head that landed as is (fast path, e.g. a verified revert): the note is on main", () => {
    const line = gitNoteLine(
      { headSha: HEAD, notesWritten: true },
      { mergedSha: HEAD, host: null },
    );
    expect(line).toEqual({
      text: "Written to refs/notes/evidence on main, on 19c18b6",
      tone: "ok",
    });
  });

  it("a replayed Change: the head's note is on the fork, what landed is signed separately", () => {
    const line = gitNoteLine(
      { headSha: HEAD, notesWritten: true },
      { mergedSha: MERGED, host: null },
    );
    expect(line.text).toBe(
      "Written to refs/notes/evidence on 19c18b6, in the change's fork. What landed (aa11bb2) has its own evidence, signed for the merged commit",
    );
    expect(line.tone).toBe("ok");
  });

  it("not merged yet: the fork note only", () => {
    const line = gitNoteLine(
      { headSha: HEAD, notesWritten: true },
      { mergedSha: null, host: null },
    );
    expect(line.text).toBe("Written to refs/notes/evidence on 19c18b6, in the change's fork");
  });

  it("merged at this head without a recorded note: says so, and where to look", () => {
    const line = gitNoteLine(
      { headSha: HEAD, notesWritten: false },
      { mergedSha: HEAD, host: null },
    );
    expect(line.tone).toBe("warn");
    expect(line.text).toMatch(/^Not written: the merge queue recorded no note on main for 19c18b6/);
    expect(line.text).toMatch(/audit log/);
  });

  it("before the note step: not written yet", () => {
    const line = gitNoteLine(
      { headSha: HEAD, notesWritten: false },
      { mergedSha: null, host: null },
    );
    expect(line.text).toMatch(/^Not written yet/);
  });

  it("a GitHub pull request never gets a git note, and that is not a warning", () => {
    const host = { number: 7 } as unknown as NonNullable<Parameters<typeof gitNoteLine>[1]["host"]>;
    const line = gitNoteLine({ headSha: HEAD, notesWritten: false }, { mergedSha: null, host });
    expect(line.tone).toBeNull();
    expect(line.text).toMatch(/GitHub pull request keeps its evidence on the platform/);
  });
});
