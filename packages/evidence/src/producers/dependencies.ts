/**
 * Dependency diff between base and head `package.json` manifests.
 *
 * Input is raw manifest text keyed by repo path (e.g. "package.json",
 * "packages/a/package.json"); a manifest missing on one side is treated as empty.
 * A manifest that does not parse makes the item `status: "error"` (the parts that
 * did parse are still reported) — never a silent "no changes".
 */
import { z } from "zod";
import { truncate } from "../encoding.js";
import type { DependencyDiff, DependencySection } from "../schema.js";
import { type LockfileChange, lockfileChanges } from "./lockfile.js";
import { semverBump } from "./semver.js";

export const DEPENDENCY_SECTIONS: readonly { section: DependencySection; dev: boolean }[] = [
  { section: "dependencies", dev: false },
  { section: "devDependencies", dev: true },
  { section: "optionalDependencies", dev: false },
  { section: "peerDependencies", dev: false },
];

/** npm lifecycle scripts that run on `install` of the package (or the repo). */
export const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;

export const LOCKFILE_NAMES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

/**
 * Validated manifest, keeping maps as entry lists. (A schema-built record would drop a
 * key like "__proto__" on the floor; reading own entries of the parsed JSON does not.)
 */
interface Manifest {
  name?: string;
  maps: Partial<Record<DependencySection | "scripts", [string, string][]>>;
}

const ManifestShape = z.object({ name: z.string().optional() });

export interface DependencyDiffOptions {
  id?: string;
  /** Explicit answer; otherwise derived from `changedPaths`. */
  lockfileChanged?: boolean;
  /** Paths touched by the change; any known lockfile among them sets `lockfileChanged`. */
  changedPaths?: readonly string[];
  /**
   * Lockfile texts by repo path at base and head (read from git objects, like the manifests).
   * Given: every lockfile change is checked against the recorded bumps (`lockfile`). Absent: the
   * item has no `lockfile`, and a changed lockfile stays unexplained.
   */
  lockfiles?: {
    base: Readonly<Record<string, string>>;
    head: Readonly<Record<string, string>>;
  };
}

function parseManifest(
  path: string,
  text: string,
): { ok: true; m: Manifest } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `${path}: invalid JSON (${(e as Error).message})` };
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, error: `${path}: manifest is not a JSON object` };
  }
  const shape = ManifestShape.safeParse(json);
  if (!shape.success) return { ok: false, error: `${path}: name: must be a string` };
  const m: Manifest = { maps: {} };
  if (shape.data.name !== undefined) m.name = shape.data.name;
  const raw = json as Record<string, unknown>;
  for (const field of [...DEPENDENCY_SECTIONS.map((s) => s.section), "scripts"] as const) {
    if (!Object.hasOwn(raw, field) || raw[field] === undefined) continue;
    const v = raw[field];
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      return { ok: false, error: `${path}: ${field}: expected an object` };
    }
    const list: [string, string][] = [];
    for (const [k, val] of Object.entries(v)) {
      if (typeof val !== "string")
        return { ok: false, error: `${path}: ${field}.${k}: expected a string` };
      list.push([k, val]);
    }
    m.maps[field] = list;
  }
  return { ok: true, m };
}

function entries(list: [string, string][] | undefined): [string, string][] {
  return list ?? [];
}

function isLockfile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return (LOCKFILE_NAMES as readonly string[]).includes(base);
}

/** Check every lockfile whose text differs between base and head. */
function checkLockfiles(
  texts: NonNullable<DependencyDiffOptions["lockfiles"]>,
  changed: DependencyDiff["changed"],
  changedPaths: readonly string[],
): NonNullable<DependencyDiff["lockfile"]> {
  const own = (m: Readonly<Record<string, string>>, k: string) =>
    Object.hasOwn(m, k) ? (m[k] ?? null) : null;
  const changes: LockfileChange[] = [];
  const problems: string[] = [];
  const paths = [...new Set([...Object.keys(texts.base), ...Object.keys(texts.head)])].sort();
  // A touched lockfile that wasn't handed over was not checked (unknown → unexplained).
  for (const path of changedPaths.filter(isLockfile))
    if (!Object.hasOwn(texts.base, path) && !Object.hasOwn(texts.head, path))
      problems.push(`${path}: changed, but its text was not read`);
  for (const path of paths.filter(isLockfile)) {
    const r = lockfileChanges(path, own(texts.base, path), own(texts.head, path), changed);
    changes.push(...r.changes);
    problems.push(...r.problems);
  }
  return {
    verified: problems.length === 0,
    changes: changes.slice(0, 2000),
    problems: problems.slice(0, 200).map((p) => truncate(p, 1000)),
  };
}

const byManifestThenName = <T extends { manifest: string; name: string }>(a: T, b: T): number =>
  a.manifest < b.manifest
    ? -1
    : a.manifest > b.manifest
      ? 1
      : a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0;

export function dependencyDiff(
  baseManifests: Readonly<Record<string, string>>,
  headManifests: Readonly<Record<string, string>>,
  opts: DependencyDiffOptions = {},
): DependencyDiff {
  const errors: string[] = [];
  const added: DependencyDiff["added"] = [];
  const removed: DependencyDiff["removed"] = [];
  const changed: DependencyDiff["changed"] = [];
  const newInstallScripts: DependencyDiff["newInstallScripts"] = [];

  const paths = [...new Set([...Object.keys(baseManifests), ...Object.keys(headManifests)])].sort();
  for (const manifest of paths) {
    const baseText = Object.hasOwn(baseManifests, manifest) ? baseManifests[manifest] : undefined;
    const headText = Object.hasOwn(headManifests, manifest) ? headManifests[manifest] : undefined;
    const empty: { ok: true; m: Manifest } = { ok: true, m: { maps: {} } };
    const b = baseText === undefined ? empty : parseManifest(manifest, baseText);
    const h = headText === undefined ? empty : parseManifest(manifest, headText);
    if (!b.ok) errors.push(`base ${b.error}`);
    if (!h.ok) errors.push(`head ${h.error}`);
    if (!b.ok || !h.ok) continue;

    for (const { section, dev } of DEPENDENCY_SECTIONS) {
      const before = new Map(entries(b.m.maps[section]));
      const after = new Map(entries(h.m.maps[section]));
      for (const [name, version] of after) {
        const prev = before.get(name);
        if (prev === undefined) added.push({ name, version, dev, manifest, section });
        else if (prev !== version) {
          changed.push({
            name,
            from: prev,
            to: version,
            bump: semverBump(prev, version),
            dev,
            manifest,
            section,
          });
        }
      }
      for (const [name, version] of before) {
        if (!after.has(name)) removed.push({ name, version, dev, manifest, section });
      }
    }

    const baseScripts = new Map(entries(b.m.maps.scripts));
    const headScripts = new Map(entries(h.m.maps.scripts));
    for (const script of LIFECYCLE_SCRIPTS) {
      const command = headScripts.get(script);
      if (command !== undefined && baseScripts.get(script) !== command) {
        newInstallScripts.push({ name: h.m.name ?? manifest, script, command, manifest });
      }
    }
  }

  const lockfile =
    opts.lockfiles === undefined
      ? undefined
      : checkLockfiles(opts.lockfiles, changed, opts.changedPaths ?? []);
  const lockfileChanged =
    opts.lockfileChanged ??
    ((opts.changedPaths ?? []).some(isLockfile) ||
      (lockfile !== undefined && (lockfile.changes.length > 0 || lockfile.problems.length > 0)));
  const item: DependencyDiff = {
    id: opts.id ?? "dependencies",
    kind: "dependencies",
    status: errors.length > 0 ? "error" : "ok",
    added: added.sort(byManifestThenName),
    removed: removed.sort(byManifestThenName),
    changed: changed.sort(byManifestThenName),
    newInstallScripts,
    lockfileChanged,
  };
  if (lockfile !== undefined) item.lockfile = lockfile;
  if (errors.length > 0) item.note = truncate(errors.join("\n"), 4000);
  return item;
}
