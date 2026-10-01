/**
 * Deterministic post-processing of the model's tour. Everything here is pure.
 *
 * Guarantees on the output:
 * - every hunkRef intersects a hunk of the diff (unknown files / lines outside hunks are dropped,
 *   partial overlaps are clamped), and every evidenceRef is an id in the evidence bundle;
 * - a stop is "proven" only if it cites an item that can prove something (status ok, not a model
 *   judgment or agent trace, not a failing/unproven test result); otherwise it becomes "unproven".
 *   "risk" verdicts are never changed;
 * - verified-transform files are one platform-written "transform" stop;
 * - a merge-queue conflict resolution is one platform-written "resolution" stop, right after the
 *   riskiest stop: verdict "risk" when it edited outside its conflict hunks (or is semantic, or
 *   failed), else "proven" only when the merged tree's tests passed;
 * - when the top-ranked hunk is anchored to a Lane-2 classifier reason, the first risk stop
 *   references that hunk (an existing risk stop is moved up, or a deterministic one inserted);
 * - stops are ordered intent → behavior → risk/proof → other → transform → uncovered;
 * - stop and word caps for the lane hold, and leastConfident / notDone have 1..10 entries.
 * Every correction is recorded in the report, and the ones a reviewer should know about are
 * stated in leastConfident / notDone.
 */
import { normalizePath } from "@app/classifier";
import type {
  ChangeDiff,
  ChangeDiffFile,
  HunkRef,
  LaneReason,
  TourStop,
  TourVerdict,
} from "@app/domain";
import type {
  ApiChange,
  ConflictResolution,
  EvidenceItem,
  ReproducibleTransform,
} from "@app/evidence";
import { baseRange, checkHunkRef, headRange, type Side } from "./diff.js";
import { lane2Anchor, type RankedHunk, type RiskFactor, refHitsCandidate } from "./rank.js";
import type { ModelTour } from "./schema.js";

// ---------------------------------------------------------------- caps & readability

export interface TourCaps {
  lane: 0 | 1 | 2;
  maxStops: number;
  maxWords: number;
}

/** Lane 1 (and shadow Lane 0) tours must read on a phone in under 3 minutes. */
export function capsForLane(lane: number): TourCaps {
  if (lane >= 2) return { lane: 2, maxStops: 12, maxWords: 900 };
  return { lane: lane <= 0 ? 0 : 1, maxStops: 7, maxWords: 450 };
}

/** Technical text on a phone: slower than the ~240 wpm prose average. */
export const READING_WPM = 180;
/** Opening a stop, glancing at its lines and verdict. */
export const SECONDS_PER_STOP = 3;
export const PHONE_TARGET_SECONDS = 180;

export interface Readability {
  words: number;
  stops: number;
  estimatedReadSeconds: number;
  maxWords: number;
  maxStops: number;
  /** Lane ≤ 1: under 3 minutes. Lane 2 has no phone target (always true). */
  withinPhoneTarget: boolean;
}

export function countWords(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

export function tourWords(
  stops: readonly TourStop[],
  leastConfident: readonly string[],
  notDone: readonly string[],
): number {
  let n = 0;
  for (const s of stops) n += countWords(s.title) + countWords(s.why);
  for (const s of leastConfident) n += countWords(s);
  for (const s of notDone) n += countWords(s);
  return n;
}

export function estimateReadSeconds(words: number, stops: number): number {
  return Math.ceil((words / READING_WPM) * 60 + stops * SECONDS_PER_STOP);
}

export function readabilityOf(
  stops: readonly TourStop[],
  leastConfident: readonly string[],
  notDone: readonly string[],
  caps: TourCaps,
): Readability {
  const words = tourWords(stops, leastConfident, notDone);
  const seconds = estimateReadSeconds(words, stops.length);
  return {
    words,
    stops: stops.length,
    estimatedReadSeconds: seconds,
    maxWords: caps.maxWords,
    maxStops: caps.maxStops,
    withinPhoneTarget: caps.lane === 2 || seconds < PHONE_TARGET_SECONDS,
  };
}

// ---------------------------------------------------------------- text helpers

function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Keep the first `n` words (n ≥ 1), marking the cut with an ellipsis. */
function firstWords(text: string, n: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= n) return text.trim();
  return `${words
    .slice(0, Math.max(1, n))
    .join(" ")
    .replace(/[,;:.]+$/, "")}…`;
}

function fmtRef(r: { file: string; startLine: number; endLine: number; side?: Side }): string {
  const lines = r.startLine === r.endLine ? `${r.startLine}` : `${r.startLine}-${r.endLine}`;
  return `${r.file}:${r.side === "base" ? "base " : ""}${lines}`;
}

function quoteList(items: readonly string[], max: number): string {
  const shown = items.slice(0, max).map((t) => `"${clip(t, 60)}"`);
  if (items.length > max) shown.push(`+${items.length - max} more`);
  return shown.join(", ");
}

// ---------------------------------------------------------------- transforms

export interface TransformCollapse {
  /** The platform's single transform stop, or null when nothing was collapsed. */
  stop: TourStop | null;
  /** Diff paths collapsed into it (left out of the model input and the ranking). */
  paths: ReadonlySet<string>;
  /** Transform names that cover the collapsed files. */
  transforms: string[];
}

function transformVerified(t: ReproducibleTransform): boolean {
  return t.status === "ok" && t.verified && t.mismatchedFiles.length === 0;
}

function spanRef(f: ChangeDiffFile): HunkRef | null {
  const heads = f.hunks.map(headRange).filter((r) => r !== null);
  if (heads.length > 0) {
    return {
      file: f.path,
      startLine: heads[0]!.startLine,
      endLine: heads[heads.length - 1]!.endLine,
      side: "head",
    };
  }
  const bases = f.hunks.map(baseRange).filter((r) => r !== null);
  if (bases.length > 0) {
    return {
      file: f.path,
      startLine: bases[0]!.startLine,
      endLine: bases[bases.length - 1]!.endLine,
      side: "base",
    };
  }
  return null;
}

/**
 * Files fully reproduced by a verified transform (path and rename source listed in a verified
 * item, same rule as the classifier) become one deterministic stop.
 */
export function collapseTransforms(
  diff: ChangeDiff,
  items: readonly EvidenceItem[],
): TransformCollapse {
  const verified = items.filter(
    (i): i is ReproducibleTransform => i.kind === "transform" && transformVerified(i),
  );
  const coveredBy = new Map<string, ReproducibleTransform[]>();
  for (const t of verified) {
    for (const f of t.files) {
      const p = normalizePath(f);
      coveredBy.set(p, [...(coveredBy.get(p) ?? []), t]);
    }
  }
  const files = diff.files.filter(
    (f) =>
      coveredBy.has(normalizePath(f.path)) &&
      (f.previousPath === null || coveredBy.has(normalizePath(f.previousPath))),
  );
  if (files.length === 0) return { stop: null, paths: new Set(), transforms: [] };

  const used = new Map<string, ReproducibleTransform>();
  for (const f of files)
    for (const t of coveredBy.get(normalizePath(f.path)) ?? []) used.set(t.id, t);
  const transforms = [...used.values()];
  const names = [...new Set(transforms.map((t) => t.transform))];
  const commands = [...new Set(transforms.map((t) => `\`${clip(t.command, 80)}\``))];
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const shownFiles = files.slice(0, 6).map((f) => f.path);
  const more =
    files.length > shownFiles.length ? ` and ${files.length - shownFiles.length} more` : "";

  const stop: TourStop = {
    kind: "transform",
    title: clip(`Mechanical: ${names.join(", ")} reproduced ${files.length} file(s)`, 160),
    why: clip(
      `Re-running ${commands.join(", ")} on base in a clean sandbox reproduced these ${files.length} file(s) byte for byte (+${adds} −${dels}): ${shownFiles.join(", ")}${more}. Nothing here was edited by hand, so skim only.`,
      1200,
    ),
    hunkRefs: files
      .map(spanRef)
      .filter((r): r is HunkRef => r !== null)
      .slice(0, 20),
    evidenceRefs: transforms.map((t) => t.id).slice(0, 20),
    verdict: "proven",
  };
  return { stop, paths: new Set(files.map((f) => f.path)), transforms: names };
}

// ---------------------------------------------------------------- conflict resolution

function resolutionOutside(r: ConflictResolution): boolean {
  return (
    r.touchesOutsideConflictHunks ||
    (r.conflictHunks.length === 0 && r.resolutionDiff.trim() !== "")
  );
}

/**
 * The merged tree's tests passed: at least one ok test run with passing tests, no test run that
 * failed or errored, and no quarantined test in the affected set (it would not have counted).
 */
export function mergedTreeTestsPassed(items: readonly EvidenceItem[]): string[] | null {
  const runs = items.filter((i) => i.kind === "test-run");
  const ok = runs.filter((r) => r.status === "ok");
  if (ok.length === 0 || runs.some((r) => r.status === "error")) return null;
  if (ok.some((r) => r.failed > 0) || !ok.some((r) => r.passed > 0)) return null;
  for (const q of items) {
    if (q.kind !== "quarantine") continue;
    if (q.status === "error" || (q.status === "ok" && q.inAffectedSet.length > 0)) return null;
  }
  return ok.map((r) => r.id);
}

function shortList(values: readonly string[], max: number): string {
  const unique = [...new Set(values)];
  const shown = unique.slice(0, max).join(", ");
  return unique.length > max ? `${shown} and ${unique.length - max} more` : shown;
}

/**
 * The platform's "Conflict resolution" stop, or null without a conflict-resolution item.
 * Everything in it comes from the evidence (computed mechanically), except the resolver's
 * rationale, which is quoted as such.
 */
export function resolutionStopFor(
  diff: ChangeDiff,
  items: readonly EvidenceItem[],
): TourStop | null {
  const all = items.filter((i): i is ConflictResolution => i.kind === "conflict-resolution");
  if (all.length === 0) return null;
  const ok = all.filter((r) => r.status === "ok");
  const failed = all.filter((r) => r.status !== "ok");
  const outside = ok.filter(resolutionOutside);
  const culprits = [
    ...new Set(ok.map((r) => r.semanticConflictWith).filter((c): c is string => c !== null)),
  ];
  const upstream = all.flatMap((r) =>
    r.upstreamChanges.map((u) => `${u.changeId} (${u.sha.slice(0, 12)})`),
  );
  const resolvers = [...new Set(all.map((r) => `${r.resolver.principalId}, ${r.resolver.model}`))];
  const tests = mergedTreeTestsPassed(items);

  const hunkRefs: HunkRef[] = [];
  const seen = new Set<string>();
  for (const r of ok) {
    for (const h of r.conflictHunks) {
      const check = checkHunkRef(diff, { ...h, side: "head" });
      if (!check.ok) continue;
      const k = `${check.ref.file}\u0000${check.ref.startLine}\u0000${check.ref.endLine}`;
      if (seen.has(k)) continue;
      seen.add(k);
      hunkRefs.push(check.ref);
    }
  }
  const files = [...new Set(ok.flatMap((r) => r.conflictHunks.map((h) => h.file)))];
  const novel = ok.reduce((n, r) => n + (r.novelLines ?? 0), 0);

  let verdict: TourVerdict;
  if (failed.length > 0 || outside.length > 0 || culprits.length > 0) verdict = "risk";
  else verdict = tests === null ? "unproven" : "proven";

  const parts: string[] = [
    `The merge queue's resolver agent (${shortList(resolvers, 2)}), not the author, resolved conflicts with upstream ${upstream.length > 0 ? shortList(upstream, 4) : "changes"}.`,
  ];
  if (failed.length > 0) {
    const note = failed.map((r) => r.note ?? "no reason recorded").join("; ");
    parts.push(`The resolution failed (${clip(note, 200)}): this change should not merge as is.`);
  }
  if (culprits.length > 0) {
    const failing = ok.flatMap((r) => r.failingTests ?? []);
    parts.push(
      `Semantic conflict: this change and ${culprits.join(", ")} each passed alone but failed together${failing.length > 0 ? ` (${shortList(failing, 3)})` : ""}; the resolver blamed ${culprits.join(", ")}.`,
    );
  }
  if (outside.length > 0) {
    parts.push(
      "It edited lines OUTSIDE the conflict hunks: read them, no one approved those lines.",
    );
  } else if (ok.length > 0) {
    parts.push(
      `It only replaced the conflict hunks${files.length > 0 ? ` in ${shortList(files, 4)}` : ""}; every other line is the mechanical merge.`,
    );
  }
  if (novel > 0) parts.push(`${novel} resolved line(s) appear on neither side of their conflict.`);
  if (ok.length > 0 && failed.length === 0) {
    parts.push(
      tests === null
        ? "No passing test run on the merged tree proves the result."
        : "The merged tree's tests pass.",
    );
  }
  const rationale = ok.map((r) => r.rationale.trim()).find((t) => t !== "");
  if (rationale !== undefined) parts.push(`Resolver's rationale: "${clip(rationale, 240)}"`);

  let title: string;
  if (failed.length > 0) title = "Conflict resolution failed";
  else if (culprits.length > 0)
    title = `Conflict resolution: semantic conflict with ${culprits.join(", ")}`;
  else
    title = `Conflict resolution against ${upstream.length} upstream change${upstream.length === 1 ? "" : "s"}`;

  const evidenceRefs = [...all.map((r) => r.id), ...(verdict === "proven" ? (tests ?? []) : [])];
  return {
    kind: "resolution",
    title: clip(title, 160),
    why: clip(parts.join(" "), 1200),
    hunkRefs: hunkRefs.slice(0, 20),
    evidenceRefs: [...new Set(evidenceRefs)].slice(0, 20),
    verdict,
  };
}

/** Put the resolution stop right after the riskiest (first risk) stop, else where risks start. */
export function placeResolutionStop(stops: readonly TourStop[], stop: TourStop): TourStop[] {
  const out = [...stops];
  const risk = out.findIndex((s) => s.kind === "risk");
  if (risk !== -1) {
    out.splice(risk + 1, 0, stop);
    return out;
  }
  const section = out.findIndex((s) => SECTION[s.kind] >= SECTION.risk);
  out.splice(section === -1 ? out.length : section, 0, stop);
  return out;
}

// ---------------------------------------------------------------- evidence

/** Whether citing this item can make a claim "proven". */
export function canProve(item: EvidenceItem): boolean {
  if (item.status !== "ok") return false;
  switch (item.kind) {
    case "llm-judgment":
    case "agent-trace":
    case "conflict-resolution":
    case "quarantine":
      return false;
    case "red-green":
      return item.verdict === "proven";
    case "test-run":
      return item.failed === 0 && item.passed > 0;
    case "transform":
      return transformVerified(item);
    default:
      return true;
  }
}

function apiChangeOf(
  items: readonly EvidenceItem[],
  ref: string | undefined,
  symbol: string,
): ApiChange | undefined {
  for (const i of items) {
    if (i.kind !== "public-api" || (ref !== undefined && i.id !== ref)) continue;
    for (const p of i.packages) {
      const hit = [...p.changed, ...p.removed].find((c) => c.symbol === symbol);
      if (hit) return hit;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- report

export interface PostprocessReport {
  droppedHunkRefs: Array<{ stop: string; ref: string; reason: "unknown-file" | "outside-hunks" }>;
  clampedHunkRefs: number;
  removedEvidenceRefs: Array<{ stop: string; ref: string }>;
  downgraded: Array<{ stop: string; from: TourVerdict; to: TourVerdict; reason: string }>;
  riskStop: {
    action: "kept" | "moved" | "inserted" | "not-required";
    reasonCode?: string;
    candidate?: string;
  };
  /** Stops removed to meet the stop or word cap. */
  droppedStops: string[];
  /** Stops whose `why` was shortened to meet the word cap. */
  shortenedStops: string[];
  /** Model leastConfident/notDone entries beyond the per-lane list cap. */
  droppedListEntries: number;
  reordered: boolean;
}

export interface PostprocessInput {
  model: ModelTour;
  diff: ChangeDiff;
  evidence: readonly EvidenceItem[];
  reasons: readonly LaneReason[];
  ranking: readonly RankedHunk[];
  transformStop: TourStop | null;
  /** The platform's conflict-resolution stop (see `resolutionStopFor`), if any. */
  resolutionStop?: TourStop | null;
  caps: TourCaps;
  /** Platform notes for notDone (diff trimmed, lockfiles not read, ...). */
  notDoneNotes?: readonly string[];
}

export interface PostprocessResult {
  stops: TourStop[];
  leastConfident: string[];
  notDone: string[];
  readability: Readability;
  report: PostprocessReport;
}

// ---------------------------------------------------------------- steps

function normalizeStop(
  raw: ModelTour["stops"][number],
  diff: ChangeDiff,
  byId: ReadonlyMap<string, EvidenceItem>,
  report: PostprocessReport,
): TourStop {
  const title = clip(raw.title, 160);
  const hunkRefs: HunkRef[] = [];
  const seenRefs = new Set<string>();
  for (const r of raw.hunkRefs) {
    const check = checkHunkRef(diff, r);
    if (!check.ok) {
      report.droppedHunkRefs.push({ stop: title, ref: fmtRef(r), reason: check.reason });
      continue;
    }
    if (check.clamped) report.clampedHunkRefs++;
    const key = `${check.ref.file}\u0000${check.ref.side}\u0000${check.ref.startLine}\u0000${check.ref.endLine}`;
    if (seenRefs.has(key)) continue;
    seenRefs.add(key);
    hunkRefs.push(check.ref);
  }

  const evidenceRefs: string[] = [];
  for (const ref of raw.evidenceRefs) {
    const id = ref.trim();
    if (!byId.has(id)) {
      report.removedEvidenceRefs.push({ stop: title, ref: id });
      continue;
    }
    if (!evidenceRefs.includes(id)) evidenceRefs.push(id);
  }

  let verdict: TourVerdict = raw.verdict;
  if (verdict === "proven") {
    const proving = evidenceRefs.filter((id) => {
      const item = byId.get(id);
      return item !== undefined && canProve(item);
    });
    let reason: string | null = null;
    if (raw.evidenceRefs.length === 0) reason = "claimed proven without citing evidence";
    else if (evidenceRefs.length === 0) reason = "cited only evidence ids that do not exist";
    else if (proving.length === 0)
      reason =
        "cited evidence that cannot prove it (errored, skipped, failing or a model judgment)";
    else if (raw.kind === "uncovered") reason = "an uncovered stop cannot be proven";
    if (reason !== null) {
      report.downgraded.push({ stop: title, from: "proven", to: "unproven", reason });
      verdict = "unproven";
    }
  }
  return { kind: raw.kind, title, why: clip(raw.why, 1200), hunkRefs, evidenceRefs, verdict };
}

function factorTitle(top: RankedHunk, factor: RiskFactor): string {
  switch (factor.code) {
    case "api-breaking":
      return `Breaking export: ${(factor.symbols ?? []).join(", ") || top.path}`;
    case "api-additive":
      return `New export: ${(factor.symbols ?? []).join(", ") || top.path}`;
    case "sensitive-path":
    case "lane2-reason":
      return `Sensitive change: ${top.path}`;
    case "policy-file":
      return `Platform policy change: ${top.path}`;
    case "migration":
      return `Database migration: ${top.path}`;
    case "scope-drift":
      return `Outside the plan's scope: ${top.path}`;
    case "dependency":
      return `Dependency change: ${top.path}`;
    default:
      return `Riskiest hunk: ${top.path}`;
  }
}

/** The platform-written risk stop for the top-ranked hunk. */
export function deterministicRiskStop(
  top: RankedHunk,
  anchor: { reason: LaneReason; factor: RiskFactor },
  evidence: readonly EvidenceItem[],
): TourStop {
  const { reason, factor } = anchor;
  const ids = new Set(evidence.map((e) => e.id));
  const parts = [clip(reason.message, 400)];
  if (factor.code === "api-breaking") {
    const symbol = factor.symbols?.[0];
    const change =
      symbol === undefined ? undefined : apiChangeOf(evidence, factor.evidenceRef, symbol);
    if (change?.before !== undefined || change?.after !== undefined) {
      parts.push(
        `\`${clip(change?.before ?? "(none)", 160)}\` becomes \`${clip(change?.after ?? "(removed)", 160)}\`.`,
      );
    }
    parts.push(
      "Every caller of the old shape breaks: check that the plan expects this and that callers are updated.",
    );
  } else {
    parts.push("Read this hunk closely before approving.");
  }
  const factors = top.factors.map((f) => f.detail);
  parts.push(`Ranked riskiest by the platform: ${clip(factors.join("; "), 300)}.`);

  const hunkRefs: HunkRef[] = [];
  if (factor.focus !== undefined && normalizePath(factor.focus.file) === normalizePath(top.path))
    hunkRefs.push(factor.focus);
  const whole = top.ref;
  if (
    !hunkRefs.some(
      (r) =>
        r.side === whole.side && r.startLine === whole.startLine && r.endLine === whole.endLine,
    )
  ) {
    hunkRefs.push(whole);
  }
  const evidenceRefs = [
    ...new Set(
      [factor.evidenceRef, reason.evidenceRef].filter(
        (r): r is string => r !== undefined && ids.has(r),
      ),
    ),
  ];
  return {
    kind: "risk",
    title: clip(factorTitle(top, factor), 160),
    why: clip(parts.join(" "), 1200),
    hunkRefs,
    evidenceRefs,
    verdict: "risk",
  };
}

function enforceRiskiest(
  stops: TourStop[],
  input: PostprocessInput,
  report: PostprocessReport,
  notes: string[],
): TourStop[] {
  const top = input.ranking[0];
  const anchor = top === undefined ? null : lane2Anchor(top, input.reasons);
  if (top === undefined || anchor === null) {
    report.riskStop = { action: "not-required" };
    return stops;
  }
  const candidate = `${fmtRef(top.ref)} (${anchor.factor.detail})`;
  const hits = (s: TourStop) => s.hunkRefs.some((r) => refHitsCandidate(r, top));
  const firstRisk = stops.findIndex((s) => s.kind === "risk");
  if (firstRisk !== -1 && hits(stops[firstRisk]!)) {
    report.riskStop = { action: "kept", reasonCode: anchor.reason.code, candidate };
    return stops;
  }
  const other = stops.findIndex((s, i) => i > firstRisk && s.kind === "risk" && hits(s));
  if (firstRisk !== -1 && other !== -1) {
    const out = [...stops];
    const [moved] = out.splice(other, 1);
    out.splice(firstRisk, 0, moved!);
    report.riskStop = { action: "moved", reasonCode: anchor.reason.code, candidate };
    return out;
  }
  const inserted = deterministicRiskStop(top, anchor, input.evidence);
  const out = [...stops];
  out.splice(firstRisk === -1 ? out.length : firstRisk, 0, inserted);
  report.riskStop = { action: "inserted", reasonCode: anchor.reason.code, candidate };
  notes.push(
    `The reviewer agent did not lead with the riskiest hunk (${fmtRef(top.ref)}: ${clip(anchor.factor.detail, 120)}), so the platform added that stop.`,
  );
  return out;
}

const SECTION: Record<TourStop["kind"], number> = {
  intent: 0,
  behavior: 1,
  risk: 2,
  proof: 2,
  resolution: 2,
  other: 3,
  transform: 4,
  uncovered: 5,
};

/** intent → behavior → (riskiest risk, then risk/proof in model order) → other → transform → uncovered. */
export function orderStops(stops: readonly TourStop[]): TourStop[] {
  const firstRisk = stops.find((s) => s.kind === "risk");
  return stops
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        SECTION[a.s.kind] - SECTION[b.s.kind] ||
        Number(b.s === firstRisk) - Number(a.s === firstRisk) ||
        a.i - b.i,
    )
    .map((x) => x.s);
}

/** Lower = more important to keep. */
function keepPriority(stops: readonly TourStop[], index: number): number {
  const s = stops[index]!;
  const isFirst = stops.findIndex((x) => x.kind === s.kind) === index;
  if (s.kind === "transform" || s.kind === "resolution") return 0;
  if (s.kind === "risk") return isFirst ? 0 : 3;
  if (s.kind === "intent") return isFirst ? 1 : 5;
  if (s.kind === "uncovered") return isFirst ? 1 : 4;
  if (s.kind === "proof" || s.kind === "behavior") return isFirst ? 2 : 4;
  return 5;
}

function dropOne(stops: TourStop[]): TourStop | undefined {
  let worst = -1;
  let worstPriority = -1;
  for (let i = 0; i < stops.length; i++) {
    const p = keepPriority(stops, i);
    if (p > 0 && p >= worstPriority) {
      worst = i;
      worstPriority = p;
    }
  }
  if (worst === -1) return undefined;
  return stops.splice(worst, 1)[0];
}

/** leastConfident / notDone entries per list: phone tours stay short. */
export function listCap(caps: TourCaps): number {
  return caps.lane === 2 ? 5 : 3;
}

/** Model entries first, then the single platform entry (always kept). */
function mergeList(
  model: readonly string[],
  platform: string | null,
  max: number,
  report: PostprocessReport,
): string[] {
  const room = platform === null ? max : max - 1;
  const fromModel = model.map((t) => clip(t, 600));
  if (fromModel.length > room) report.droppedListEntries += fromModel.length - room;
  const out = fromModel.slice(0, room);
  if (platform !== null) out.push(platform);
  return out.length > 0 ? out : ["Nothing to report."];
}

function combine(prefix: string, notes: readonly string[]): string | null {
  return notes.length === 0 ? null : clip(`${prefix} ${notes.join(" ")}`, 600);
}

const MIN_WHY_WORDS = 12;

/**
 * Shrink text until the tour fits `maxWords`. Never drops a stop: with the caps used here
 * (≤ 12 stops, ≤ 10 list entries) the floors below always fit (lane 1: 7×12 + 7×12 + 6×15 = 258
 * ≤ 450; lane 2: 12×12 + 12×12 + 10×15 = 438 ≤ 900).
 */
function enforceWordCap(
  stops: TourStop[],
  leastConfident: string[],
  notDone: string[],
  maxWords: number,
  report: PostprocessReport,
): void {
  if (tourWords(stops, leastConfident, notDone) <= maxWords) return;
  const shrinkLists = (n: number) => {
    for (const list of [leastConfident, notDone]) {
      for (let i = 0; i < list.length; i++) list[i] = firstWords(list[i]!, n);
    }
  };
  const fitWhys = (floor: number): boolean => {
    const fixed =
      stops.reduce((n, s) => n + countWords(s.title), 0) +
      leastConfident.reduce((n, s) => n + countWords(s), 0) +
      notDone.reduce((n, s) => n + countWords(s), 0);
    const budget = maxWords - fixed;
    const words = stops.map((s) => countWords(s.why));
    const sum = (limit: number) => words.reduce((n, w) => n + Math.min(w, limit), 0);
    if (sum(Number.POSITIVE_INFINITY) <= budget) return true;
    if (sum(floor) > budget) return false;
    // Largest per-why limit that fits: short whys stay whole, the longest give up the most.
    let lo = floor;
    let hi = Math.max(floor, ...words);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (sum(mid) <= budget) lo = mid;
      else hi = mid - 1;
    }
    for (let i = 0; i < stops.length; i++) {
      if (words[i]! > lo) {
        stops[i] = { ...stops[i]!, why: firstWords(stops[i]!.why, lo) };
        if (!report.shortenedStops.includes(stops[i]!.title))
          report.shortenedStops.push(stops[i]!.title);
      }
    }
    return true;
  };
  shrinkLists(40);
  if (fitWhys(MIN_WHY_WORDS)) return;
  shrinkLists(15);
  if (fitWhys(MIN_WHY_WORDS)) return;
  for (let i = 0; i < stops.length; i++)
    stops[i] = { ...stops[i]!, title: firstWords(stops[i]!.title, 12) };
  if (fitWhys(MIN_WHY_WORDS)) return;
  fitWhys(1);
}

/** Turn the validated model output into final stops, lists and a readability measurement. */
export function postprocessTour(input: PostprocessInput): PostprocessResult {
  const report: PostprocessReport = {
    droppedHunkRefs: [],
    clampedHunkRefs: 0,
    removedEvidenceRefs: [],
    downgraded: [],
    riskStop: { action: "not-required" },
    droppedStops: [],
    shortenedStops: [],
    droppedListEntries: 0,
    reordered: false,
  };
  const byId = new Map(input.evidence.map((e) => [e.id, e]));
  const lcNotes: string[] = [];
  const ndNotes: string[] = [...(input.notDoneNotes ?? [])];

  // 1. Refs and verdicts.
  let stops = input.model.stops.map((s) => normalizeStop(s, input.diff, byId, report));

  // 2. The riskiest thing comes first among the risks.
  stops = enforceRiskiest(stops, input, report, lcNotes);

  // 3. The platform's transform stop.
  if (input.transformStop !== null) stops.push(input.transformStop);

  // 4. Order.
  const ordered = orderStops(stops);
  report.reordered = ordered.some((s, i) => s !== stops[i]);
  stops = ordered;

  // 4b. The platform's conflict-resolution stop, right after the riskiest stop.
  if (input.resolutionStop) stops = placeResolutionStop(stops, input.resolutionStop);

  // 5. Stop cap.
  while (stops.length > input.caps.maxStops) {
    const dropped = dropOne(stops);
    if (dropped === undefined) break;
    report.droppedStops.push(dropped.title);
  }
  if (report.droppedStops.length > 0)
    ndNotes.push(`Omitted for length: ${quoteList(report.droppedStops, 4)}.`);

  // 6. Say what the platform corrected.
  if (report.droppedHunkRefs.length > 0) {
    lcNotes.push(
      `${report.droppedHunkRefs.length} cited location(s) outside the diff were removed (${report.droppedHunkRefs
        .slice(0, 4)
        .map((d) => d.ref)
        .join(", ")}).`,
    );
  }
  if (report.removedEvidenceRefs.length > 0) {
    lcNotes.push(
      `Evidence ids that do not exist were removed (${[...new Set(report.removedEvidenceRefs.map((r) => r.ref))].slice(0, 5).join(", ")}).`,
    );
  }
  if (report.downgraded.length > 0) {
    lcNotes.push(
      `${report.downgraded.length} stop(s) claimed proof without usable evidence and are marked unproven: ${quoteList(
        report.downgraded.map((d) => d.stop),
        3,
      )}.`,
    );
  }
  const max = listCap(input.caps);
  const leastConfident = mergeList(
    input.model.leastConfident,
    combine("Platform checks:", lcNotes),
    max,
    report,
  );
  const notDone = mergeList(input.model.notDone, combine("Platform:", ndNotes), max, report);

  // 7. Word cap.
  enforceWordCap(stops, leastConfident, notDone, input.caps.maxWords, report);

  return {
    stops,
    leastConfident,
    notDone,
    readability: readabilityOf(stops, leastConfident, notDone, input.caps),
    report,
  };
}
