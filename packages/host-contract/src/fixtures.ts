/**
 * The fixture repositories (`fixtures/`, see fixtures/README.md) as in-memory trees: the base is
 * `_base` plus the fixture's `base/` overlay, the head is the base plus `head/` minus
 * `deleted.txt`. Hosts seed these (native: Artifacts fakes; GitHub: recorded fixture repos).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo path → file content (utf-8). */
export type FileTree = Record<string, string>;

export const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

function readTree(dir: string): FileTree {
  const out: FileTree = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === ".materialized") continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full).split("\\").join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

export interface FixtureTrees {
  base: FileTree;
  head: FileTree;
  /** What the head changes on top of the base (null deletes), as one push. */
  push: Record<string, string | null>;
  /** `expected.evidence.changedFiles` from fixture.json, when present. */
  changedFiles: string[] | null;
  /** `claim.title` from fixture.json. */
  title: string;
}

export function loadFixture(name: string): FixtureTrees {
  const dir = join(FIXTURES_DIR, name);
  if (!existsSync(join(dir, "fixture.json"))) throw new Error(`no fixture ${name}`);
  const base = { ...readTree(join(FIXTURES_DIR, "_base")), ...readTree(join(dir, "base")) };
  const overlay = readTree(join(dir, "head"));
  const deletedFile = join(dir, "deleted.txt");
  const deleted = existsSync(deletedFile)
    ? readFileSync(deletedFile, "utf8")
        .split("\n")
        .map((l) => l.replace(/#.*$/, "").trim())
        .filter((l) => l !== "")
    : [];
  const head: FileTree = { ...base, ...overlay };
  for (const path of deleted) delete head[path];
  const push: Record<string, string | null> = { ...overlay };
  for (const path of deleted) push[path] = null;
  const meta = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8")) as {
    claim?: { title?: string };
    expected?: { evidence?: { changedFiles?: string[] } };
  };
  return {
    base,
    head,
    push,
    changedFiles: meta.expected?.evidence?.changedFiles ?? null,
    title: meta.claim?.title ?? name,
  };
}
