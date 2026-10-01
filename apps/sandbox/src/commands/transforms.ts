/**
 * `evidence transforms`: for each transform script under `.platform/transforms/` in the BASE
 * tree, run the base copy on a clean worktree of base and compare the files it changed with head,
 * byte for byte (git blob ids).
 *
 * Per touched path (vs base):
 * - head has exactly the transform's output → reproduced;
 * - head left the path as it is on base → the change did not apply this transform there;
 * - anything else → mismatch.
 * A transform whose output appears nowhere in head does not apply to this change: `skipped`.
 * Otherwise `verified` = no mismatch and no unapplied path. Paths the change touched that the
 * transform didn't are hand edits and are not claimed by the item.
 *
 * The script comes from base on purpose: a script added or edited by the change itself could
 * simply write head's files (see DECISIONS.md, "Reproducible transforms run the BASE copy").
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReproducibleTransform } from "@app/evidence";
import type { Context } from "../lib/context.js";
import { git, listTree, removeWorktree } from "../lib/git.js";
import { errorMessage, log, tail } from "../lib/log.js";
import { run } from "../lib/proc.js";
import { linkNodeModules, manifestPaths, prepareBaseWorktree, sameDependencyGraph } from "../lib/repo.js";
import { joinNotes } from "./items.js";

export const TRANSFORMS_DIR = ".platform/transforms/";

interface TransformScript {
  name: string;
  /** Repo-relative path of the file node runs. */
  path: string;
  argv: string[];
  command: string;
}

const RUNNABLE: Array<[RegExp, (p: string) => string[]]> = [
  [/\.(mjs|cjs|js)$/, (p) => ["node", p]],
  [/\.(ts|mts|cts)$/, (p) => ["node", "--experimental-strip-types", "--no-warnings", p]],
  [/\.sh$/, (p) => ["sh", p]],
];

/** Transform scripts in the base tree: direct children files, or `<dir>/index.{mjs,js,ts}`. */
export async function transformScripts(ctx: Context): Promise<{ scripts: TransformScript[]; ignored: string[] }> {
  const entries = (await listTree(ctx.repo, ctx.base)).filter((e) => e.type === "blob" && e.path.startsWith(TRANSFORMS_DIR));
  const scripts: TransformScript[] = [];
  const ignored: string[] = [];
  const dirsWithIndex = new Set<string>();
  for (const e of entries.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const rest = e.path.slice(TRANSFORMS_DIR.length);
    const parts = rest.split("/");
    let file: string | null = null;
    let name = "";
    if (parts.length === 1) {
      file = e.path;
      name = rest.replace(/\.[^.]+$/, "");
    } else if (parts.length === 2 && /^index\.(mjs|cjs|js|ts|mts)$/.test(parts[1] ?? "") && !dirsWithIndex.has(parts[0] ?? "")) {
      file = e.path;
      name = parts[0] ?? rest;
      dirsWithIndex.add(name);
    }
    if (file === null) continue;
    const runner = RUNNABLE.find(([re]) => re.test(file));
    if (runner === undefined) {
      if (parts.length === 1 && !/\.(md|txt|json)$/i.test(rest)) ignored.push(e.path);
      continue;
    }
    const argv = runner[1](file);
    scripts.push({ name, path: file, argv, command: argv.join(" ") });
  }
  return { scripts, ignored };
}

interface TreeMap {
  [path: string]: string;
}

async function treeBlobs(repo: string, rev: string): Promise<TreeMap> {
  const out: TreeMap = {};
  for (const e of await listTree(repo, rev)) if (e.type === "blob" || e.type === "commit") out[e.path] = `${e.mode}:${e.object}`;
  return out;
}

/**
 * Tree of the worktree's current content (tracked + untracked, honoring .gitignore), written via
 * a scratch index so the worktree's own index is untouched. Linked `node_modules` are excluded.
 */
async function snapshotTree(dir: string, scratch: string, base: string): Promise<string> {
  const indexFile = `${scratch}.index`;
  const excludes = `${scratch}.exclude`;
  writeFileSync(excludes, "node_modules\n");
  const env = { GIT_INDEX_FILE: indexFile };
  rmSync(indexFile, { force: true });
  await git(dir, ["read-tree", base], { env });
  await git(dir, ["-c", `core.excludesFile=${excludes}`, "add", "-A"], { env });
  return (await git(dir, ["write-tree"], { env })).stdout.trim();
}

function transformError(script: TransformScript, note: string): ReproducibleTransform {
  return {
    id: `transform:${script.name}`,
    kind: "transform",
    status: "error",
    note: note.slice(0, 4000),
    transform: script.name,
    command: script.command,
    verified: false,
    files: [],
    mismatchedFiles: [],
  };
}

async function runOne(ctx: Context, script: TransformScript, head: TreeMap, baseTree: TreeMap, deps: { linked: boolean; differs: boolean }): Promise<ReproducibleTransform> {
  const wtPath = join(ctx.tmp, `transform-${script.name.replace(/[^A-Za-z0-9._-]/g, "_")}`);
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
    const notes: string[] = [];
    if (deps.linked) linkNodeModules(ctx.repo, prepared.dir, await manifestPaths(ctx.repo, ctx.base));
    else if (deps.differs) notes.push("dependencies differ between base and head, so the transform ran without node_modules");
    log(`transform ${script.name}: ${script.command} on a clean base worktree`);
    const timeoutMs = Number(process.env.GITTIFACTS_TRANSFORM_TIMEOUT_MS) || 10 * 60_000;
    const [cmd = "node", ...args] = script.argv;
    const r = await run(cmd === "node" ? process.execPath : cmd, args, { cwd: prepared.dir, timeoutMs, env: { NODE_OPTIONS: undefined } });
    if (r.timedOut) return transformError(script, `the transform did not finish within ${Math.round(timeoutMs / 1000)} s`);
    if (r.code !== 0) return transformError(script, `the transform exited ${r.code}: ${tail(r.stdout + r.stderr, 10)}`);
    const produced = await snapshotTree(prepared.dir, join(ctx.tmp, `snapshot-${script.name.replace(/[^A-Za-z0-9._-]/g, "_")}`), ctx.base);
    const after = await treeBlobs(ctx.repo, produced);
    const paths = new Set([...Object.keys(baseTree), ...Object.keys(after)]);
    const touched = [...paths].filter((p) => baseTree[p] !== after[p]).sort();
    const reproduced: string[] = [];
    const unapplied: string[] = [];
    const mismatched: string[] = [];
    for (const p of touched) {
      if (head[p] === after[p]) reproduced.push(p);
      else if (head[p] === baseTree[p]) unapplied.push(p);
      else mismatched.push(p);
    }
    const base: Omit<ReproducibleTransform, "status" | "verified" | "files" | "mismatchedFiles"> = {
      id: `transform:${script.name}`,
      kind: "transform",
      transform: script.name,
      command: script.command,
    };
    if (touched.length === 0 || reproduced.length === 0) {
      const why = touched.length === 0 ? "the transform changes nothing on base" : `none of the ${touched.length} file(s) it rewrites on base match head`;
      return {
        ...base,
        status: "skipped",
        note: joinNotes([`does not apply to this change: ${why}`, ...notes]) ?? "",
        verified: false,
        files: [],
        mismatchedFiles: [],
      };
    }
    // Partially applied: the paths head left untouched count as mismatches (head ≠ transform output).
    const mismatchedFiles = [...mismatched, ...unapplied].sort();
    if (unapplied.length > 0) notes.push(`head did not apply the transform to: ${unapplied.join(", ")}`);
    if (mismatched.length > 0) notes.push(`head differs from the transform's output in: ${mismatched.join(", ")}`);
    const item: ReproducibleTransform = {
      ...base,
      status: "ok",
      verified: mismatchedFiles.length === 0,
      files: reproduced,
      mismatchedFiles,
    };
    const note = joinNotes([...notes, `reproduced ${reproduced.length} of ${touched.length} file(s) the transform rewrites`]);
    if (note !== undefined) item.note = note;
    return item;
  } catch (error) {
    return transformError(script, `running the transform failed: ${errorMessage(error)}`);
  } finally {
    await removeWorktree(ctx.repo, wtPath).catch(() => {});
  }
}

export async function transforms(ctx: Context): Promise<ReproducibleTransform[]> {
  const { scripts, ignored } = await transformScripts(ctx);
  for (const p of ignored) log(`transforms: ignoring ${p} (not a .mjs/.js/.cjs/.ts/.sh script)`);
  if (scripts.length === 0) return [];
  const [head, baseTree] = await Promise.all([treeBlobs(ctx.repo, ctx.head), treeBlobs(ctx.repo, ctx.base)]);
  const same = await sameDependencyGraph(ctx.repo, ctx.base, ctx.head);
  const items: ReproducibleTransform[] = [];
  for (const script of scripts) {
    items.push(await runOne(ctx, script, head, baseTree, { linked: same, differs: !same }));
  }
  return items;
}

