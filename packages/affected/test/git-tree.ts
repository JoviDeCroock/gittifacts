/** Test helper: AffectedSet of a commit range in a real repository (plain git, no sandbox lib). */
import { execFileSync } from "node:child_process";
import {
  type AffectedSet,
  type ChangeStatus,
  type ComputeInput,
  computeAffectedSet,
  contentNeeded,
  type FileChange,
  type RepoTree,
} from "../src/index.js";

function git(dir: string, args: string[], input?: string): Buffer {
  return execFileSync("git", ["-C", dir, ...args], {
    input,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  });
}

interface Entry {
  oid: string;
  path: string;
}

function lsTree(dir: string, rev: string): Entry[] {
  return git(dir, ["ls-tree", "-r", "-z", "--full-tree", rev])
    .toString("utf8")
    .split("\0")
    .filter((r) => r !== "")
    .flatMap((r) => {
      const tab = r.indexOf("\t");
      const [, type, oid] = r.slice(0, tab).split(" ");
      return type === "blob" && oid !== undefined ? [{ oid, path: r.slice(tab + 1) }] : [];
    });
}

function catFile(dir: string, oids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (oids.length === 0) return out;
  const buf = git(dir, ["cat-file", "--batch"], `${oids.join("\n")}\n`);
  let pos = 0;
  for (const oid of oids) {
    const nl = buf.indexOf(10, pos);
    const size = Number(buf.subarray(pos, nl).toString("utf8").split(" ")[2]);
    out.set(oid, buf.subarray(nl + 1, nl + 1 + size).toString("utf8"));
    pos = nl + 1 + size + 1;
  }
  return out;
}

export function changesBetween(dir: string, base: string, head: string): FileChange[] {
  const parts = git(dir, ["diff", "--name-status", "-z", "-M", base, head, "--"])
    .toString("utf8")
    .split("\0");
  const out: FileChange[] = [];
  const status = (c: string): ChangeStatus =>
    c === "A"
      ? "added"
      : c === "D"
        ? "deleted"
        : c === "R"
          ? "renamed"
          : c === "C"
            ? "copied"
            : "modified";
  for (let i = 0; i < parts.length; ) {
    const s = parts[i++] ?? "";
    if (s === "") continue;
    if (s.startsWith("R") || s.startsWith("C")) {
      const from = parts[i++] ?? "";
      out.push({ status: status(s[0] ?? ""), path: parts[i++] ?? "", oldPath: from });
    } else out.push({ status: status(s[0] ?? ""), path: parts[i++] ?? "" });
  }
  return out;
}

export function treeAt(dir: string, rev: string, want: (path: string) => boolean): RepoTree {
  const entries = lsTree(dir, rev);
  const byPath = new Map(entries.map((e) => [e.path, e.oid]));
  const contents = catFile(
    dir,
    entries.filter((e) => want(e.path)).map((e) => e.oid),
  );
  return {
    files: entries.map((e) => e.path).sort(),
    read: (p) => {
      const oid = byPath.get(p);
      return oid === undefined ? null : (contents.get(oid) ?? null);
    },
  };
}

export function affectedBetween(
  dir: string,
  base: string,
  head: string,
  extra: Partial<ComputeInput> = {},
): AffectedSet {
  const changes = changesBetween(dir, base, head);
  const touched = new Set(changes.flatMap((c) => [c.path, c.oldPath ?? c.path]));
  return computeAffectedSet({
    head: treeAt(dir, head, (p) => contentNeeded(p)),
    base: treeAt(dir, base, (p) => touched.has(p) && contentNeeded(p)),
    changes,
    ...extra,
  });
}
