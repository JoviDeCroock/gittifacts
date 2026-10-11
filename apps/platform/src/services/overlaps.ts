/**
 * Overlapping work: which OPEN Changes in a repo (not merged, released, reverted, rejected or
 * abandoned) share a change's Plan or touch the same paths. Agents get it from start_change and
 * get_change_status; the merge-queue view shows it per entry. Read-only and bounded: the newest
 * OVERLAP_SCAN_LIMIT open changes are compared, paths come from each one's stored diff at its
 * current head (no hunks read; see D1Store.changedPathsAt).
 *
 * Unknown escalates: a change with nothing pushed yet is still listed when it shares the Plan
 * (reason `paths-unknown`), and any open change whose path overlap can't be decided is named in
 * `unchecked`, never silently dropped.
 */
import { compileGlobs, normalizePath } from "@app/classifier";
import { pageUrl } from "@app/conventions";
import {
  type Change,
  type ChangeOverlap,
  OVERLAP_MAX_ENTRIES,
  OVERLAP_MAX_PATHS,
  type OverlapReason,
  type OverlapReport,
} from "@app/domain";
import { assertChangeAccess } from "../access/access.js";
import type { Caller, Services } from "../app-env.js";
import type { ChangeSummary } from "../store/d1-store.js";

/** Statuses of a change someone is still working on (not yet on main, not ended). */
export const OPEN_STATUSES: readonly Change["status"][] = [
  "awaiting-push",
  "running",
  "failing",
  "awaiting-review",
  "approved",
  "queued",
];

/** At most this many open changes are compared (newest first). */
export const OVERLAP_SCAN_LIMIT = 50;

/** What a change is compared on. */
export interface OverlapSubject {
  /** The change itself (excluded from its own report); null before it exists. */
  changeId: string | null;
  planId: string | null;
  /** Concrete paths, compared exactly (a diff's files, or intended paths as written). */
  files: readonly string[];
  /** Globs (intended paths, a plan's scopePaths), matched against the others' changed paths. */
  globs: readonly string[];
}

interface OpenChange {
  change: ChangeSummary;
  /** Changed paths at its current head; null when unknown (nothing pushed, or no diff yet). */
  paths: string[] | null;
  /** While `paths` is null: the paths it said it would touch at start_change (stored). */
  intended: string[];
  /** While `paths` is null: its plan's scopePaths. */
  scope: string[];
}

export interface OverlapIndex {
  open: readonly OpenChange[];
  truncated: boolean;
  report(subject: OverlapSubject): OverlapReport;
  /** A change as a subject: its diff at the current head, else its intended paths + plan scope. */
  subjectOf(change: Change): Promise<OverlapSubject>;
}

/** Loads the repo's open changes and their changed paths once; reports are then pure. */
export async function loadOverlapIndex(svc: Services, repoId: string): Promise<OverlapIndex> {
  const rows = await svc.store.listChangeSummaries(repoId, {
    statuses: [...OPEN_STATUSES],
    limit: OVERLAP_SCAN_LIMIT + 1,
  });
  const truncated = rows.length > OVERLAP_SCAN_LIMIT;
  const scanned = rows.slice(0, OVERLAP_SCAN_LIMIT);
  const heads = scanned.flatMap((c) =>
    c.headSha === null ? [] : [{ changeId: c.id, headSha: c.headSha }],
  );
  const paths = await svc.store.changedPathsAt(heads);
  // No head (or no diff yet): compare on what it said it would touch, plus its plan's scope.
  const headless = scanned.filter((c) => !paths.has(c.id));
  const intents = await svc.store.changeIntentsOf(headless.map((c) => c.id));
  const scopes = new Map<string, string[]>();
  for (const planId of new Set(headless.flatMap((c) => (c.planId === null ? [] : [c.planId])))) {
    scopes.set(planId, (await svc.store.getPlan(planId))?.scopePaths ?? []);
  }
  const open = scanned.map((change) => {
    const known = paths.get(change.id) ?? null;
    return {
      change,
      paths: known,
      intended: known === null ? (intents.get(change.id) ?? []) : [],
      scope: known === null && change.planId !== null ? (scopes.get(change.planId) ?? []) : [],
    };
  });
  const origin = svc.origin;
  return {
    open,
    truncated,
    report: (subject) => compareOverlaps(subject, open, truncated, origin),
    async subjectOf(change) {
      let files: string[] | null = open.find((o) => o.change.id === change.id)?.paths ?? null;
      if (files === null && change.headSha !== null) {
        const own = await svc.store.changedPathsAt([
          { changeId: change.id, headSha: change.headSha },
        ]);
        files = own.get(change.id) ?? null;
      }
      if (files !== null) return { changeId: change.id, planId: change.planId, files, globs: [] };
      // Nothing pushed yet: what it said it would touch, plus its plan's scope.
      const scannedSelf = open.find((o) => o.change.id === change.id);
      const intended =
        scannedSelf?.intended ??
        (await svc.store.changeIntentsOf([change.id])).get(change.id) ??
        [];
      const plan = change.planId === null ? null : await svc.store.getPlan(change.planId);
      return {
        changeId: change.id,
        planId: change.planId,
        files: intended,
        globs: [...intended, ...(plan?.scopePaths ?? [])],
      };
    },
  };
}

/** The overlap report of one change (get_change_status, GET /changes/:id/overlaps). */
export async function getChangeOverlaps(
  svc: Services,
  caller: Caller,
  changeId: string,
): Promise<OverlapReport> {
  const change = await assertChangeAccess(svc, caller.principal, changeId, "read");
  const index = await loadOverlapIndex(svc, change.repoId);
  return index.report(await index.subjectOf(change));
}

/**
 * Intended work at start_change: the caller's paths (exactly and as globs) and the plan's
 * scopePaths. The new change is excluded by id.
 */
export async function startOverlaps(
  svc: Services,
  change: Change,
  intendedPaths: readonly string[],
): Promise<OverlapReport> {
  const plan = change.planId === null ? null : await svc.store.getPlan(change.planId);
  const index = await loadOverlapIndex(svc, change.repoId);
  return index.report({
    changeId: change.id,
    planId: change.planId,
    files: intendedPaths,
    globs: [...intendedPaths, ...(plan?.scopePaths ?? [])],
  });
}

const GLOB_CHARS = /[*?[\]{}!]/;
const isGlob = (p: string) => GLOB_CHARS.test(p);

/** The literal directory segments before a glob's first wildcard ("src/billing/**" → src, billing). */
function globBase(p: string): string[] {
  const out: string[] = [];
  for (const seg of normalizePath(p).split("/")) {
    if (isGlob(seg)) break;
    out.push(seg);
  }
  return out;
}

/** Two globs may match a common file when one's literal base is a prefix of the other's. */
function globsMayMeet(a: string, b: string): boolean {
  const [x, y] = [globBase(a), globBase(b)];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Which of another change's intended paths/globs meet the subject's files and globs. Literal vs
 * literal: equal. Glob vs literal: matches. Glob vs glob: their literal bases nest (an overlap
 * reported too often beats one missed: unknown escalates).
 */
function intendedHits(
  intended: readonly string[],
  files: ReadonlySet<string>,
  globs: readonly string[],
  subjectGlob: ((p: string) => boolean) | null,
): string[] {
  const hits = new Set<string>();
  for (const raw of intended) {
    const i = normalizePath(raw);
    if (i === "") continue;
    if (!isGlob(i)) {
      if (files.has(i) || (subjectGlob !== null && subjectGlob(i))) hits.add(i);
      continue;
    }
    const m = compileGlobs([i], "match-all");
    if ([...files].some((f) => m(f))) hits.add(i);
    else if (globs.some((g) => (isGlob(g) ? globsMayMeet(i, g) : m(normalizePath(g))))) hits.add(i);
  }
  return [...hits].sort();
}

const listed = (paths: readonly string[]) =>
  paths.length <= 3
    ? paths.join(", ")
    : `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more`;

/** Pure: compare one subject against the open changes. */
export function compareOverlaps(
  subject: OverlapSubject,
  open: readonly OpenChange[],
  truncated: boolean,
  origin: string,
): OverlapReport {
  const files = new Set(subject.files.map(normalizePath));
  // An unreadable glob matches everything: an overlap note too many beats one missing.
  const glob = subject.globs.length > 0 ? compileGlobs(subject.globs, "match-all") : null;
  const known = files.size > 0 || glob !== null;
  const found: { entry: ChangeOverlap; rank: number }[] = [];
  const unchecked: string[] = [];
  let scanned = 0;
  for (const o0 of open) {
    const { change: o, paths } = o0;
    if (o.id === subject.changeId) continue;
    scanned += 1;
    const samePlan = subject.planId !== null && o.planId === subject.planId;
    const reasons: OverlapReason[] = [];
    if (samePlan) {
      reasons.push({
        code: "same-plan",
        message: `Started from the same plan (${o.planId})`,
        paths: [],
        morePaths: 0,
      });
    }
    // Nothing pushed: its stored intended paths, plus its plan's scope (same plan: already said).
    const intended = paths === null ? [...o0.intended, ...(samePlan ? [] : o0.scope)] : [];
    if (paths === null && intended.length > 0 && known) {
      const hit = intendedHits(intended, files, subject.globs, glob);
      if (hit.length > 0) {
        reasons.push({
          code: "same-paths",
          message: `Nothing pushed yet; intends to touch the same ${hit.length === 1 ? "path" : "paths"}: ${listed(hit)}`,
          paths: hit.slice(0, OVERLAP_MAX_PATHS),
          morePaths: Math.max(0, hit.length - OVERLAP_MAX_PATHS),
        });
      }
    } else if (paths === null && intended.length > 0) {
      if (!samePlan) {
        unchecked.push(o.id);
        continue;
      }
    } else if (paths === null) {
      if (!samePlan) {
        unchecked.push(o.id);
        continue;
      }
      reasons.push({
        code: "paths-unknown",
        message: "Nothing pushed yet: which paths it touches is unknown until it pushes",
        paths: [],
        morePaths: 0,
      });
    } else if (!known) {
      if (!samePlan) {
        unchecked.push(o.id);
        continue;
      }
    } else {
      const hit = paths.filter((p) => files.has(p) || (glob !== null && glob(p))).sort();
      if (hit.length > 0) {
        reasons.push({
          code: "same-paths",
          message: `Touches the same ${hit.length === 1 ? "path" : "paths"}: ${listed(hit)}`,
          paths: hit.slice(0, OVERLAP_MAX_PATHS),
          morePaths: Math.max(0, hit.length - OVERLAP_MAX_PATHS),
        });
      }
    }
    if (reasons.length === 0) continue;
    const samePaths = reasons.some((r) => r.code === "same-paths");
    found.push({
      rank: (samePlan ? 1 : 0) + (samePaths ? 2 : 0),
      entry: {
        changeId: o.id,
        title: o.title,
        status: o.status,
        lane: o.lane,
        headSha: o.headSha,
        planId: o.planId,
        author: { id: o.authorId, kind: o.authorKind, name: o.authorName },
        reasons,
        pathsKnown: paths !== null || intended.length > 0,
        pathsFrom: paths !== null ? "head" : intended.length > 0 ? "intended" : null,
        url: pageUrl(origin, { changeId: o.id }),
      },
    });
  }
  // Same paths and plan first, then same paths, then same plan; newest first within each (stable).
  found.sort((a, b) => b.rank - a.rank);
  return {
    overlaps: found.slice(0, OVERLAP_MAX_ENTRIES).map((f) => f.entry),
    moreOverlaps: Math.max(0, found.length - OVERLAP_MAX_ENTRIES),
    comparedPaths: [...new Set([...files, ...subject.globs])].slice(0, 100),
    scanned,
    truncated,
    unchecked: unchecked.slice(0, 50),
  };
}

/**
 * The merge-queue view: each queue entry that is still open gets the open Changes it overlaps
 * (one index for the whole queue). Entries beyond the scan, or finished ones, get none. A failed
 * read leaves the overview as it was (overlaps absent = not known), never fails the queue.
 */
export async function withQueueOverlaps<E extends { changeId: string }, Q extends { entries: E[] }>(
  svc: Services,
  repoId: string,
  overview: Q,
): Promise<Q & { entries: (E & { overlaps?: ChangeOverlap[] })[] }> {
  try {
    const index = await loadOverlapIndex(svc, repoId);
    const open = new Map(index.open.map((o) => [o.change.id, o.change]));
    const entries = await Promise.all(
      overview.entries.map(async (e) => {
        const change = open.get(e.changeId);
        if (change === undefined) return e;
        const report = index.report(await index.subjectOf(change));
        return { ...e, overlaps: report.overlaps };
      }),
    );
    return { ...overview, entries };
  } catch (err) {
    console.warn("queue overview: overlap check failed", err);
    return overview;
  }
}
