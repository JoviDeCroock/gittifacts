/**
 * `affected --base <sha> --head <sha> [--coverage-map <file>] [--public-api-evidence <file>]`:
 * the Change's AffectedSet for the merge queue's conflict graph (`@app/affected`), printed as
 * one `::affected::<json>` line. It is not an EvidenceItem, hence its own marker.
 *
 * Everything is read from git objects (`ls-tree` + one `cat-file --batch`), so the working tree
 * may be anywhere. Fail closed: when the analysis cannot run, the document still prints, with
 * `complete: false` (the queue treats it as conflicting with everything), all tests and
 * `publicApi: true`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AFFECTED_VERSION,
  AffectedSet,
  ALL_TESTS,
  type ChangeStatus,
  type CoverageMap,
  computeAffectedSet,
  contentNeeded,
  type FileChange,
  parseCoverageMap,
  type RepoTree,
} from "@app/affected";
import { PublicApiDiff } from "@app/evidence";
import { readBlobs } from "../lib/blob-batch.js";
import { type Context, createContext, disposeContext, UsageError } from "../lib/context.js";
import { listTree, nameStatus, type TreeEntry } from "../lib/git.js";
import { errorMessage, log } from "../lib/log.js";

export const AFFECTED_PREFIX = "::affected::";

export interface AffectedCommandInput {
  cwd: string;
  base: string | undefined;
  head: string | undefined;
  /** Coverage map from main's last full run (see `parseCoverageMap` for the shapes). */
  coverageMap: string | undefined;
  /** A `public-api` evidence item (JSON) for a precise `publicApi` verdict. */
  publicApiEvidence: string | undefined;
}

const STATUS: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

/** The fail-closed document: unknown, so it conflicts with everything. */
export function affectedError(note: string, files: readonly string[] = []): AffectedSet {
  const sorted = [...new Set(files)].sort();
  return {
    files: sorted,
    modules: sorted,
    testTargets: [ALL_TESTS],
    publicApi: true,
    deploysTo: [],
    complete: false,
    analyzers: [
      {
        name: "gittifacts-runner",
        version: AFFECTED_VERSION,
        complete: false,
        note: note.slice(0, 4000),
      },
    ],
  };
}

function treeOf(
  entries: readonly TreeEntry[],
  contents: ReadonlyMap<string, string | null>,
): RepoTree {
  const blobs = entries.filter((e) => e.type === "blob");
  const byPath = new Map(blobs.map((e) => [e.path, e.object]));
  return {
    files: blobs.map((e) => e.path).sort(),
    read: (p) => {
      const oid = byPath.get(p);
      return oid === undefined ? null : (contents.get(oid) ?? null);
    },
  };
}

function loadCoverage(
  file: string,
  cwd: string,
  repo: string,
  files: readonly string[],
): { coverage: CoverageMap | null; notes: string[] } {
  try {
    // Report paths are absolute in the run that produced them; strip this checkout's root, and
    // fall back to unique-suffix matching for maps produced in another checkout directory.
    const parsed = parseCoverageMap(readFileSync(resolve(cwd, file), "utf8"), {
      files,
      root: repo,
    });
    return { coverage: parsed.map, notes: parsed.notes };
  } catch (error) {
    // An unusable map is not a reason to guess: static test selection takes over.
    return {
      coverage: null,
      notes: [`coverage map ${file} unusable (${errorMessage(error)}); static test selection used`],
    };
  }
}

function loadPublicApi(
  file: string,
  cwd: string,
): { publicApi: boolean | null; note: string | null } {
  try {
    const item = PublicApiDiff.parse(JSON.parse(readFileSync(resolve(cwd, file), "utf8")));
    if (item.status !== "ok")
      return {
        publicApi: null,
        note: `public-api evidence is ${item.status}; the exported-signature diff decides`,
      };
    return { publicApi: item.classification !== "none", note: null };
  } catch (error) {
    return {
      publicApi: null,
      note: `public-api evidence ${file} unusable (${errorMessage(error)}); the exported-signature diff decides`,
    };
  }
}

export async function computeAffected(
  ctx: Context,
  input: Pick<AffectedCommandInput, "cwd" | "coverageMap" | "publicApiEvidence">,
): Promise<AffectedSet> {
  const [ns, headEntries, baseEntries] = await Promise.all([
    nameStatus(ctx.repo, ctx.base, ctx.head),
    listTree(ctx.repo, ctx.head),
    listTree(ctx.repo, ctx.base),
  ]);
  const changes: FileChange[] = ns.map((c) => ({
    status: STATUS[c.status] ?? "modified",
    path: c.path,
    oldPath: c.oldPath,
  }));
  const touched = new Set(changes.flatMap((c) => [c.path, c.oldPath ?? c.path]));
  const wanted = [
    ...headEntries.filter((e) => e.type === "blob" && contentNeeded(e.path)),
    ...baseEntries.filter((e) => e.type === "blob" && touched.has(e.path) && contentNeeded(e.path)),
  ];
  const t0 = Date.now();
  const contents = await readBlobs(
    ctx.repo,
    wanted.map((e) => e.object),
  );
  log(
    `affected: ${changes.length} changed path(s); read ${contents.size} blob(s) in ${Date.now() - t0} ms`,
  );
  const head = treeOf(headEntries, contents);
  const base = treeOf(baseEntries, contents);

  const notes: string[] = [];
  let coverage: CoverageMap | null = null;
  let coverageNotes: string[] = [];
  if (input.coverageMap !== undefined) {
    ({ coverage, notes: coverageNotes } = loadCoverage(
      input.coverageMap,
      input.cwd,
      ctx.repo,
      head.files,
    ));
  }
  let publicApi: boolean | null = null;
  if (input.publicApiEvidence !== undefined) {
    const api = loadPublicApi(input.publicApiEvidence, input.cwd);
    publicApi = api.publicApi;
    if (api.note !== null) notes.push(api.note);
  }
  const t1 = Date.now();
  const set = computeAffectedSet({
    head,
    base,
    changes,
    coverage,
    coverageNotes,
    publicApi,
    notes,
  });
  log(
    `affected: ${set.modules.length} module(s), ${set.testTargets.length} test target(s), complete=${set.complete} in ${Date.now() - t1} ms`,
  );
  return set;
}

/** The `affected` command: always one `::affected::` document unless the usage is wrong. */
export async function affectedCommand(
  input: AffectedCommandInput,
  emit: (doc: AffectedSet) => void,
): Promise<number> {
  let ctx: Context;
  try {
    ctx = await createContext({
      cwd: input.cwd,
      base: input.base,
      head: input.head,
      packageManager: null,
      testCommand: null,
      needsBase: true,
    });
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    log(`cannot prepare the checkout: ${errorMessage(error)}`);
    emit(affectedError(`cannot prepare the checkout: ${errorMessage(error)}`));
    return 0;
  }
  try {
    let doc: AffectedSet;
    try {
      doc = await computeAffected(ctx, input);
    } catch (error) {
      log(
        `affected failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      const files = await nameStatus(ctx.repo, ctx.base, ctx.head)
        .then((ns) => ns.flatMap((c) => [c.path, c.oldPath ?? c.path]))
        .catch(() => []);
      doc = affectedError(`affected analysis failed: ${errorMessage(error)}`, files);
    }
    const valid = AffectedSet.safeParse(doc);
    if (!valid.success) {
      const issue = valid.error.issues[0];
      doc = affectedError(
        `internal error: the runner produced an invalid AffectedSet (${issue?.path.join(".")}: ${issue?.message})`,
        doc.files,
      );
    }
    emit(doc);
    return 0;
  } finally {
    disposeContext(ctx);
  }
}
