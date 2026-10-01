/**
 * `evidence public-api`: the exported surface of every TypeScript package entry point at base
 * (clean worktree, head's node_modules linked for type resolution) and head (the working tree),
 * diffed by the pure producer.
 */
import { join } from "node:path";
import { type PackageSurfaces, type PublicApiDiff, publicApiDiff } from "@app/evidence";
import {
  discoverEntries,
  extractPackageSurfaces,
  type PackageEntry,
  type SurfaceResult,
} from "../lib/api-surface.js";
import { type Context, workdirCheck } from "../lib/context.js";
import { listTree, readBlob, removeWorktree } from "../lib/git.js";
import { errorMessage, log } from "../lib/log.js";
import {
  linkNodeModules,
  manifestPaths,
  prepareBaseWorktree,
  sameDependencyGraph,
} from "../lib/repo.js";
import { joinNotes, publicApiError, withNote } from "./items.js";

async function discoverAt(ctx: Context, rev: string) {
  const tree = await listTree(ctx.repo, rev);
  const paths = new Set(tree.filter((e) => e.type === "blob").map((e) => e.path));
  const manifests = await manifestPaths(ctx.repo, rev);
  const cache = new Map<string, string | null>();
  for (const m of manifests) {
    const dir = m === "package.json" ? "" : m.slice(0, -"/package.json".length);
    for (const p of [m, dir === "" ? "tsconfig.json" : `${dir}/tsconfig.json`]) {
      if (paths.has(p) && !cache.has(p)) cache.set(p, await readBlob(ctx.repo, rev, p));
    }
  }
  return {
    manifests,
    discovery: discoverEntries(manifests, {
      exists: (p) => paths.has(p),
      read: (p) => cache.get(p) ?? null,
    }),
  };
}

function extractAll(rootAbs: string, entries: readonly PackageEntry[]): Map<string, SurfaceResult> {
  const byDir = new Map<string, PackageEntry[]>();
  for (const e of entries) {
    const list = byDir.get(e.dir) ?? [];
    list.push(e);
    byDir.set(e.dir, list);
  }
  const out = new Map<string, SurfaceResult>();
  for (const list of byDir.values()) {
    const results = extractPackageSurfaces(rootAbs, list);
    for (const e of list) {
      const r = results.get(e.entry);
      if (r !== undefined) out.set(`${e.name}\0${e.entry}`, r);
    }
  }
  return out;
}

export async function publicApi(ctx: Context): Promise<PublicApiDiff> {
  const [base, head] = await Promise.all([discoverAt(ctx, ctx.base), discoverAt(ctx, ctx.head)]);
  const notes: string[] = [];
  const problems = [
    ...new Set([
      ...base.discovery.problems.map((p) => `base: ${p}`),
      ...head.discovery.problems.map((p) => `head: ${p}`),
    ]),
  ];
  if (base.manifests.length === 0 && head.manifests.length === 0) {
    return {
      ...publicApiDiff([]),
      status: "skipped",
      note: "no package.json in the repository, so there is no package API to compare",
    };
  }
  if (base.discovery.entries.length === 0 && head.discovery.entries.length === 0) {
    if (problems.length > 0)
      return publicApiError(
        joinNotes([
          "could not locate the TypeScript sources of the declared entry points",
          ...problems,
        ]) ?? "",
      );
    return withNote(
      publicApiDiff([]),
      "no package declares a TypeScript entry point (exports/types) or has src/index.ts",
    );
  }
  const wd = workdirCheck(ctx);
  if (wd.error !== null) return publicApiError(wd.error);

  log(
    `public-api: head entries ${head.discovery.entries.map((e) => `${e.name}:${e.entry}`).join(", ") || "none"}`,
  );
  const headResults = extractAll(ctx.repo, head.discovery.entries);

  const wtPath = join(ctx.tmp, "base-api");
  let baseResults = new Map<string, SurfaceResult>();
  if (base.discovery.entries.length > 0) {
    try {
      const prepared = await prepareBaseWorktree({
        repo: ctx.repo,
        headDir: ctx.repo,
        base: ctx.base,
        head: ctx.head,
        path: wtPath,
        packageManager: ctx.packageManager,
        needDeps: false,
      });
      // Only types are needed from dependencies: reuse head's install.
      linkNodeModules(ctx.repo, prepared.dir, base.manifests);
      if (!(await sameDependencyGraph(ctx.repo, ctx.base, ctx.head))) {
        notes.push(
          "dependencies differ between base and head; base declarations were resolved against head's node_modules",
        );
      }
      baseResults = extractAll(prepared.dir, base.discovery.entries);
    } catch (error) {
      return publicApiError(`preparing the base worktree failed: ${errorMessage(error)}`);
    } finally {
      await removeWorktree(ctx.repo, wtPath).catch(() => {});
    }
  }

  const keys = new Map<string, { name: string; entry: string }>();
  for (const e of [...base.discovery.entries, ...head.discovery.entries])
    keys.set(`${e.name}\0${e.entry}`, { name: e.name, entry: e.entry });
  const packages: PackageSurfaces[] = [];
  const errors: string[] = [];
  for (const [key, { name, entry }] of [...keys].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const b = baseResults.get(key);
    const h = headResults.get(key);
    if (b?.error !== undefined) errors.push(`base ${name} ${entry}: ${b.error}`);
    if (h?.error !== undefined) errors.push(`head ${name} ${entry}: ${h.error}`);
    if ((b?.typeErrors ?? 0) > 0)
      notes.push(`base ${name} has ${b?.typeErrors} type error(s); its surface may be imprecise`);
    if ((h?.typeErrors ?? 0) > 0)
      notes.push(`head ${name} has ${h?.typeErrors} type error(s); its surface may be imprecise`);
    packages.push({ name, entry, base: b?.surface ?? null, head: h?.surface ?? null });
  }
  const item = publicApiDiff(packages);
  if (errors.length > 0 || problems.length > 0) {
    // Unknown is not "none": an entry we could not read may hide a breaking change.
    return {
      ...item,
      status: "error",
      note: joinNotes([...errors, ...problems, ...notes]) ?? "error",
    };
  }
  return withNote(item, ...notes, wd.note);
}
