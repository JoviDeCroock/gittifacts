import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ConflictMarkers,
  capResolutionDiff,
  checkConflictResolution,
  checkQuarantine,
  conflictResolutionError,
  conflictResolutionItem,
  EvidenceItem,
  generateSigningKey,
  hasConflictMarkers,
  parseConflicts,
  type QuarantinedTest,
  quarantineEvidence,
  RESOLUTION_DIFF_MAX_BYTES,
  resolutionScope,
  type Signer,
  signEvidence,
  summarizeItem,
  unifiedFileDiff,
  verifyEvidence,
} from "../src/index.js";
import { HEAD_SHA } from "./helpers.js";

const M: ConflictMarkers = { size: 7, ours: "upstream", base: "base", theirs: "change" };
const RESOLVER = {
  model: "anthropic/claude-sonnet-5",
  principalId: "system:resolver",
  promptVersion: "resolver-test",
};
const UP = [{ changeId: "chg_up", sha: "c".repeat(40), planId: "plan_up" }];

/** A file where upstream and the change both appended to a list. */
const MERGED = [
  "export const list = [",
  '  "a",',
  "<<<<<<< upstream",
  '  "from-upstream",',
  "||||||| base",
  "=======",
  '  "from-change",',
  ">>>>>>> change",
  "];",
  "",
  "export const other = 1;",
  "",
].join("\n");

describe("parseConflicts", () => {
  it("splits diff3 output into clean segments and regions", () => {
    const p = parseConflicts(MERGED, M);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.regions).toHaveLength(1);
    expect(p.regions[0]).toMatchObject({
      index: 1,
      ours: ['  "from-upstream",\n'],
      base: [],
      theirs: ['  "from-change",\n'],
      startLine: 3,
      endLine: 8,
    });
    expect(p.segments.map((s) => s.kind)).toEqual(["clean", "conflict", "clean"]);
  });

  it("parses merge style (no base section) and git's default markers", () => {
    const text = "x\n<<<<<<< HEAD\n1\n=======\n2\n>>>>>>> abc1234 (msg)\ny\n";
    const p = parseConflicts(text);
    expect(p.ok && p.regions[0]?.base).toBeNull();
  });

  it("ignores marker-like content when labels are exact", () => {
    const text = "<<<<<<< not-ours\nplain\n";
    expect(parseConflicts(text, M)).toMatchObject({ ok: true, regions: [] });
    expect(hasConflictMarkers(text, M)).toBe(false);
    expect(hasConflictMarkers(text)).toBe(true);
  });

  it("rejects malformed regions", () => {
    expect(parseConflicts("<<<<<<< upstream\na\n", M)).toMatchObject({ ok: false });
    expect(parseConflicts("<<<<<<< upstream\na\n>>>>>>> change\n", M)).toMatchObject({
      ok: false,
    });
    expect(parseConflicts("a\n>>>>>>> change\n", M)).toMatchObject({ ok: false });
  });

  it("parses what `git merge-file --diff3 --marker-size` writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtf-merge-file-"));
    try {
      writeFileSync(join(dir, "ours"), "a\nb-upstream\nc\n");
      writeFileSync(join(dir, "base"), "a\nb\nc\n");
      writeFileSync(join(dir, "theirs"), "a\nb-change\nc\n");
      let out = "";
      try {
        execFileSync(
          "git",
          [
            "merge-file",
            "-p",
            "--diff3",
            "--marker-size=13",
            "-L",
            "upstream",
            "-L",
            "base",
            "-L",
            "change",
            "ours",
            "base",
            "theirs",
          ],
          { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: devNull }, encoding: "utf8" },
        );
      } catch (e) {
        out = (e as { stdout: string }).stdout; // exit code = number of conflicts
      }
      const p = parseConflicts(out, { size: 13, ours: "upstream", base: "base", theirs: "change" });
      expect(p.ok && p.regions.map((r) => [r.ours, r.base, r.theirs])).toEqual([
        [["b-upstream\n"], ["b\n"], ["b-change\n"]],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolutionScope", () => {
  const resolvedWithin = MERGED.replace(
    /<<<<<<< upstream\n[\s\S]*?>>>>>>> change\n/,
    '  "from-upstream",\n  "from-change",\n',
  );

  it("a resolution that only replaces the region is within, with its head lines", () => {
    const s = resolutionScope(
      [{ path: "src/list.ts", merged: MERGED, resolved: resolvedWithin, conflicted: true }],
      M,
    );
    expect(s.touchesOutsideConflictHunks).toBe(false);
    expect(s.conflictHunks).toEqual([{ file: "src/list.ts", startLine: 3, endLine: 4 }]);
    expect(s.novelLines).toBe(0);
    expect(s.unresolvedFiles).toEqual([]);
  });

  it("editing a clean line is outside, and the edited lines are reported", () => {
    const resolved = resolvedWithin.replace("export const other = 1;", "export const other = 2;");
    const s = resolutionScope(
      [{ path: "src/list.ts", merged: MERGED, resolved, conflicted: true }],
      M,
    );
    expect(s.touchesOutsideConflictHunks).toBe(true);
    expect(s.outsideFiles).toEqual(["src/list.ts"]);
    expect(s.conflictHunks.some((h) => h.startLine <= 7 && h.endLine >= 7)).toBe(true);
  });

  it("touching a file that was not in conflict is outside", () => {
    const s = resolutionScope(
      [
        { path: "src/list.ts", merged: MERGED, resolved: resolvedWithin, conflicted: true },
        { path: "src/other.ts", merged: "a\n", resolved: "a\nb\n", conflicted: false },
        { path: "src/same.ts", merged: "a\n", resolved: "a\n", conflicted: false },
      ],
      M,
    );
    expect(s.outsideFiles).toEqual(["src/other.ts"]);
    expect(s.touchesOutsideConflictHunks).toBe(true);
  });

  it("counts lines that appear on neither side as novel", () => {
    const resolved = MERGED.replace(
      /<<<<<<< upstream\n[\s\S]*?>>>>>>> change\n/,
      '  "from-upstream",\n  "from-change",\n  "smuggled",\n',
    );
    const s = resolutionScope(
      [{ path: "src/list.ts", merged: MERGED, resolved, conflicted: true }],
      M,
    );
    expect(s.touchesOutsideConflictHunks).toBe(false);
    expect(s.novelLines).toBe(1);
  });

  it("an empty replacement is anchored on the following line", () => {
    const resolved = MERGED.replace(/<<<<<<< upstream\n[\s\S]*?>>>>>>> change\n/, "");
    const s = resolutionScope(
      [{ path: "src/list.ts", merged: MERGED, resolved, conflicted: true }],
      M,
    );
    expect(s.conflictHunks).toEqual([{ file: "src/list.ts", startLine: 3, endLine: 3 }]);
  });

  it("leftover markers are unresolved", () => {
    const s = resolutionScope(
      [{ path: "src/list.ts", merged: MERGED, resolved: MERGED, conflicted: true }],
      M,
    );
    expect(s.unresolvedFiles).toEqual(["src/list.ts"]);
  });

  it("is exact when clean segments repeat inside a resolution (greedy is still right)", () => {
    const merged = [
      "<<<<<<< upstream",
      "u1",
      "=======",
      "c1",
      ">>>>>>> change",
      "}",
      "<<<<<<< upstream",
      "u2",
      "=======",
      "c2",
      ">>>>>>> change",
      "",
    ].join("\n");
    const within = ["u1", "}", "c1", "}", "u2", "c2", ""].join("\n");
    const s1 = resolutionScope([{ path: "f", merged, resolved: within, conflicted: true }], {
      size: 7,
    });
    expect(s1.touchesOutsideConflictHunks).toBe(false);
    const dropped = ["u1", "c1", "u2", "c2", ""].join("\n"); // removed the clean "}"
    const s2 = resolutionScope([{ path: "f", merged, resolved: dropped, conflicted: true }], {
      size: 7,
    });
    expect(s2.touchesOutsideConflictHunks).toBe(true);
  });

  it("whole-file conflicts accept any content or a deletion", () => {
    const s = resolutionScope(
      [
        {
          path: "src/deleted-upstream.ts",
          merged: "kept by the change\n",
          resolved: null,
          conflicted: true,
          wholeFile: true,
        },
        {
          path: "src/both-added.ts",
          merged: "x\n",
          resolved: "x\ny\n",
          conflicted: true,
          wholeFile: true,
          sides: { ours: "x\n", base: null, theirs: "y\n" },
        },
      ],
      M,
    );
    expect(s.touchesOutsideConflictHunks).toBe(false);
    expect(s.conflictHunks).toEqual([{ file: "src/both-added.ts", startLine: 1, endLine: 2 }]);
    expect(s.novelLines).toBe(0);
  });

  it("deleting a file with clean lines outside its regions is outside", () => {
    const s = resolutionScope(
      [{ path: "src/list.ts", merged: MERGED, resolved: null, conflicted: true }],
      M,
    );
    expect(s.touchesOutsideConflictHunks).toBe(true);
  });

  it("unparseable markers count every edit as outside", () => {
    const s = resolutionScope(
      [{ path: "f", merged: "<<<<<<< upstream\nx\n", resolved: "x\n", conflicted: true }],
      M,
    );
    expect(s.touchesOutsideConflictHunks).toBe(true);
  });
});

describe("conflict-resolution items", () => {
  const scope = resolutionScope(
    [
      {
        path: "src/list.ts",
        merged: MERGED,
        resolved: MERGED.replace(/<<<<<<< upstream\n[\s\S]*?>>>>>>> change\n/, '  "a2",\n'),
        conflicted: true,
      },
    ],
    M,
  );

  it("builds a schema-valid ok item", () => {
    const item = conflictResolutionItem({
      upstreamChanges: [...UP, ...UP],
      ontoSha: "d".repeat(40),
      scope,
      resolutionDiff: unifiedFileDiff({ path: "src/list.ts", before: MERGED, after: "x\n" }),
      semanticConflictWith: null,
      rationale: "Kept both list entries.",
      resolver: RESOLVER,
      attempts: 1,
    });
    expect(EvidenceItem.parse(item)).toEqual(item);
    expect(item.upstreamChanges).toHaveLength(1);
    expect(item.touchesOutsideConflictHunks).toBe(false);
    expect(checkConflictResolution(item)).toEqual([]);
    expect(summarizeItem(item)).toBe(
      "resolved against 1 upstream change, within 1 conflict hunk (anthropic/claude-sonnet-5)",
    );
  });

  it("edits without any conflict hunk (semantic conflicts) count as outside", () => {
    const item = conflictResolutionItem({
      upstreamChanges: UP,
      scope: { conflictHunks: [], touchesOutsideConflictHunks: false, novelLines: 2 },
      resolutionDiff: unifiedFileDiff({ path: "src/a.ts", before: "a\n", after: "b\n" }),
      semanticConflictWith: "chg_up",
      failingTests: ["test/a.test.ts > a"],
      rationale: "Upstream renamed the field.",
      resolver: RESOLVER,
      attempts: 2,
    });
    expect(item.touchesOutsideConflictHunks).toBe(true);
    expect(EvidenceItem.safeParse(item).success).toBe(true);
    expect(summarizeItem(item)).toContain("semantic conflict with chg_up");
  });

  it("caps the diff at the byte limit, on a line boundary", () => {
    const line = `${"+é".repeat(100)}\n`; // 301 bytes
    const big = line.repeat(Math.ceil((RESOLUTION_DIFF_MAX_BYTES * 1.5) / 301));
    const capped = capResolutionDiff(big);
    expect(capped.truncated).toBe(true);
    expect(new TextEncoder().encode(capped.text).length).toBeLessThanOrEqual(
      RESOLUTION_DIFF_MAX_BYTES,
    );
    expect(capped.text.endsWith("\n")).toBe(true);
    const oneLine = capResolutionDiff("é".repeat(40_000));
    expect(oneLine.truncated).toBe(true);
    expect(new TextEncoder().encode(oneLine.text).length).toBeLessThanOrEqual(
      RESOLUTION_DIFF_MAX_BYTES,
    );
    expect(capResolutionDiff("short\n")).toEqual({ text: "short\n", truncated: false });
  });

  it("the schema rejects an over-cap diff and an inverted hunk", () => {
    const item = conflictResolutionItem({
      upstreamChanges: UP,
      scope,
      resolutionDiff: "x\n",
      semanticConflictWith: null,
      rationale: "",
      resolver: RESOLVER,
      attempts: 1,
    });
    expect(EvidenceItem.safeParse({ ...item, resolutionDiff: "é".repeat(40_000) }).success).toBe(
      false,
    );
    expect(
      EvidenceItem.safeParse({
        ...item,
        conflictHunks: [{ file: "a", startLine: 5, endLine: 4 }],
      }).success,
    ).toBe(false);
  });

  it("an errored resolution counts as outside and is consistent", () => {
    const item = conflictResolutionError({
      note: "model output invalid twice",
      upstreamChanges: UP,
      resolver: RESOLVER,
      attempts: 2,
    });
    expect(item).toMatchObject({ status: "error", touchesOutsideConflictHunks: true });
    expect(EvidenceItem.safeParse(item).success).toBe(true);
    expect(checkConflictResolution(item)).toEqual([]);
    expect(summarizeItem(item)).toBe("measurement failed: model output invalid twice");
  });

  it("flags inconsistent items", () => {
    const item = conflictResolutionItem({
      upstreamChanges: UP,
      scope,
      resolutionDiff: "x\n",
      semanticConflictWith: null,
      rationale: "",
      resolver: RESOLVER,
      attempts: 1,
    });
    expect(
      checkConflictResolution({
        ...item,
        conflictHunks: [],
        touchesOutsideConflictHunks: false,
        semanticConflictWith: "chg_unknown",
      }),
    ).toHaveLength(2);
  });
});

describe("quarantine", () => {
  const T = (id: string, file: string): QuarantinedTest => ({
    id,
    file,
    name: id,
    flakeRate: 0.2,
    quarantinedAt: "2026-10-01T10:00:00.000Z",
  });
  const tests = [T("t1", "test/a.test.ts"), T("t2", "test/b.test.ts"), T("t3", "pkg/c.test.ts")];

  it("lists only the quarantined tests in the affected set", () => {
    const item = quarantineEvidence({
      quarantined: [...tests, tests[0]!],
      affected: { testTargets: ["test/a.test.ts", "t3"] },
    });
    expect(item.tests).toHaveLength(3);
    expect(item.inAffectedSet).toEqual(["t1", "t3"]);
    expect(EvidenceItem.parse(item)).toEqual(item);
    expect(checkQuarantine(item)).toEqual([]);
    expect(summarizeItem(item)).toBe("3 quarantined tests, 2 in the affected set");
  });

  it("matches globs and treats unknown or unparseable targets as affected", () => {
    expect(
      quarantineEvidence({ quarantined: tests, affected: { testTargets: ["test/**"] } })
        .inAffectedSet,
    ).toEqual(["t1", "t2"]);
    expect(
      quarantineEvidence({ quarantined: tests, affected: { testTargets: ["{a,b}".repeat(11)] } })
        .inAffectedSet,
    ).toEqual(["t1", "t2", "t3"]);
    const unknown = quarantineEvidence({ quarantined: tests, affected: null });
    expect(unknown.inAffectedSet).toEqual(["t1", "t2", "t3"]);
    expect(unknown.note).toMatch(/affected set unknown/);
  });

  it("flags affected ids that are not quarantined", () => {
    const item = quarantineEvidence({ quarantined: tests, affected: { testTargets: [] } });
    expect(checkQuarantine({ ...item, inAffectedSet: ["nope"] })).toEqual([
      "inAffectedSet lists nope, which is not quarantined",
    ]);
  });
});

describe("signing", () => {
  let signer: Signer;
  beforeAll(async () => {
    const k = await generateSigningKey();
    signer = { privateKey: k.privateKey, publicKey: k.publicKey, name: "gittifacts-queue" };
  });

  it("signs and verifies bundles with the new kinds", async () => {
    const items = [
      conflictResolutionError({
        note: "budget exceeded",
        upstreamChanges: UP,
        resolver: RESOLVER,
        attempts: 0,
      }),
      quarantineEvidence({ quarantined: [], affected: null }),
    ];
    const signed = await signEvidence({ changeId: "chg_1", headSha: HEAD_SHA, items }, signer);
    const r = await verifyEvidence(JSON.parse(JSON.stringify(signed)), signer.publicKey);
    expect(r.ok).toBe(true);
  });
});
