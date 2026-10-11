import { describe, expect, it } from "vitest";
import { DependencyDiff, dependencyDiff, lockfileChanges } from "../src/index.js";

const BUMP = { name: "left-pad", from: "^1.3.0", to: "^1.3.1", bump: "patch" };

/** A pnpm v9 lockfile with left-pad at `v` (and `extra` lines appended to sections). */
function pnpm(
  v: string,
  o: { resolution?: string; extraPackages?: string; overrides?: string; spec?: string } = {},
) {
  return [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    ...(o.overrides ? ["", "overrides:", o.overrides] : []),
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      left-pad:",
    `        specifier: ${o.spec ?? (v === "1.3.0" ? "^1.3.0" : "^1.3.1")}`,
    `        version: ${v}`,
    "      pad-user:",
    "        specifier: ^2.0.0",
    "        version: 2.0.0",
    "",
    "packages:",
    "",
    `  left-pad@${v}:`,
    `    resolution: ${o.resolution ?? `{integrity: sha512-${v === "1.3.0" ? "AAAA" : "BBBB"}==}`}`,
    "    engines: {node: '>=10'}",
    "",
    "  pad-user@2.0.0:",
    "    resolution: {integrity: sha512-CCCC==}",
    ...(o.extraPackages ? ["", o.extraPackages] : []),
    "",
    "snapshots:",
    "",
    `  left-pad@${v}: {}`,
    "",
    "  pad-user@2.0.0:",
    "    dependencies:",
    `      left-pad: ${v}`,
    "",
  ].join("\n");
}

const check = (base: string, head: string, path = "pnpm-lock.yaml") =>
  lockfileChanges(path, base, head, [BUMP]);

describe("pnpm-lock.yaml", () => {
  it("a recorded patch bump re-resolved from the registry is fully explained", () => {
    const r = check(pnpm("1.3.0"), pnpm("1.3.1"));
    expect(r.problems).toEqual([]);
    expect(r.changes).toEqual([
      { lockfile: "pnpm-lock.yaml", name: "left-pad", from: "1.3.0", to: "1.3.1" },
    ]);
  });

  it("the bumped entry resolving to a tarball (not the registry) is a problem", () => {
    const evil = "{tarball: https://evil.example/left-pad-1.3.1.tgz}";
    const r = check(pnpm("1.3.0"), pnpm("1.3.1", { resolution: evil }));
    expect(r.problems.join("\n")).toContain("does not resolve from the registry");
  });

  it("an integrity rewritten without a version change is a problem", () => {
    const r = check(pnpm("1.3.0"), pnpm("1.3.0", { resolution: "{integrity: sha512-EVIL==}" }));
    expect(r.problems.join("\n")).toContain("left-pad@1.3.0 changed more than a version bump");
  });

  it("a new (transitive) package, an unrecorded bump or a new override are problems", () => {
    const extra = "  evil@1.0.0:\n    resolution: {integrity: sha512-DDDD==}";
    expect(
      check(pnpm("1.3.0"), pnpm("1.3.1", { extraPackages: extra })).problems.join("\n"),
    ).toContain("evil");
    const other = lockfileChanges("pnpm-lock.yaml", pnpm("1.3.0"), pnpm("1.3.1"), []);
    expect(other.problems.join("\n")).toContain("no manifest patch bump records it");
    const ov = check(pnpm("1.3.0"), pnpm("1.3.1", { overrides: "  left-pad: npm:evil@1.0.0" }));
    expect(ov.problems.join("\n")).toContain("settings or overrides changed");
  });

  it("an importer specifier the manifest didn't record is a problem", () => {
    const r = check(pnpm("1.3.0"), pnpm("1.3.1", { spec: "github:evil/left-pad" }));
    expect(r.problems.join("\n")).toContain("importer . dependencies.left-pad changed unrecorded");
  });

  it("an unreadable lockfile, a v5 lockfile or another format can't be checked", () => {
    expect(check(pnpm("1.3.0"), "lockfileVersion: '9.0'\n\tbad: tab\n").problems).toHaveLength(1);
    expect(check("lockfileVersion: 5.4\n", "lockfileVersion: 5.4\nx: 1\n").problems[0]).toContain(
      "not supported",
    );
    expect(check("a\n", "b\n", "yarn.lock").problems[0]).toContain("unsupported lockfile format");
    expect(check(pnpm("1.3.0"), null as unknown as string).problems[0]).toContain("deleted");
  });
});

/** A package-lock.json v3 with left-pad at `v`. */
function npm(v: string, o: { resolved?: string; extra?: Record<string, unknown> } = {}) {
  return JSON.stringify({
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "app",
        version: "1.0.0",
        dependencies: { "left-pad": v === "1.3.0" ? "^1.3.0" : "^1.3.1" },
      },
      "node_modules/left-pad": {
        version: v,
        resolved: o.resolved ?? `https://registry.npmjs.org/left-pad/-/left-pad-${v}.tgz`,
        integrity: `sha512-${v}`,
        license: "WTFPL",
      },
      ...o.extra,
    },
  });
}

describe("package-lock.json", () => {
  const checkNpm = (b: string, h: string) => lockfileChanges("package-lock.json", b, h, [BUMP]);

  it("a recorded patch bump from the same registry is explained", () => {
    const r = checkNpm(npm("1.3.0"), npm("1.3.1"));
    expect(r.problems).toEqual([]);
    expect(r.changes).toEqual([
      { lockfile: "package-lock.json", name: "left-pad", from: "1.3.0", to: "1.3.1" },
    ]);
  });

  it("another host, a new entry or a new install script are problems", () => {
    const evil = checkNpm(
      npm("1.3.0"),
      npm("1.3.1", { resolved: "https://evil.example/left-pad-1.3.1.tgz" }),
    );
    expect(evil.problems.join("\n")).toContain("does not resolve from the registry");
    const added = checkNpm(
      npm("1.3.0"),
      npm("1.3.1", { extra: { "node_modules/evil": { version: "1.0.0" } } }),
    );
    expect(added.problems.join("\n")).toContain("new lock entries node_modules/evil");
    const script = JSON.parse(npm("1.3.1"));
    script.packages["node_modules/left-pad"].hasInstallScript = true;
    expect(checkNpm(npm("1.3.0"), JSON.stringify(script)).problems.join("\n")).toContain(
      "changed more than its version",
    );
  });
});

describe("dependencyDiff with lockfiles", () => {
  const manifest = (r: string) => JSON.stringify({ dependencies: { "left-pad": r } });
  it("records the lockfile check when the texts are given, and nothing when they aren't", () => {
    const base = { "package.json": manifest("^1.3.0") };
    const head = { "package.json": manifest("^1.3.1") };
    const checked = dependencyDiff(base, head, {
      changedPaths: ["package.json", "pnpm-lock.yaml"],
      lockfiles: {
        base: { "pnpm-lock.yaml": pnpm("1.3.0") },
        head: { "pnpm-lock.yaml": pnpm("1.3.1") },
      },
    });
    expect(DependencyDiff.parse(checked)).toEqual(checked);
    expect(checked.lockfile).toEqual({
      verified: true,
      changes: [{ lockfile: "pnpm-lock.yaml", name: "left-pad", from: "1.3.0", to: "1.3.1" }],
      problems: [],
    });
    const missing = dependencyDiff(base, head, {
      changedPaths: ["package.json", "packages/a/pnpm-lock.yaml"],
      lockfiles: { base: {}, head: {} },
    });
    expect(missing.lockfile?.verified).toBe(false);
    expect(missing.lockfile?.problems[0]).toContain("not read");
    const unread = dependencyDiff(base, head, { changedPaths: ["package.json", "pnpm-lock.yaml"] });
    expect(unread.lockfileChanged).toBe(true);
    expect(unread.lockfile).toBeUndefined();
  });
});
