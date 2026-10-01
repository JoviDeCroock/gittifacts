/**
 * Diff helpers: hunk line ranges, hunk-ref validation, and the compact unified rendering the
 * model reads (with line numbers, trimmed to a token budget).
 */
import { compileGlobs, LOCKFILE_GLOBS, normalizePath } from "@app/classifier";
import type { ChangeDiff, ChangeDiffFile, DiffHunk, HunkRef } from "@app/domain";
import { estimateTokens } from "./budget.js";

export type Side = "head" | "base";

export interface LineRange {
  startLine: number;
  endLine: number;
}

/** Head-side range of a hunk, or null when it has no head lines (pure deletion). */
export function headRange(h: DiffHunk): LineRange | null {
  return h.newLines > 0 && h.newStart > 0
    ? { startLine: h.newStart, endLine: h.newStart + h.newLines - 1 }
    : null;
}

/** Base-side range of a hunk, or null when it has no base lines (pure addition). */
export function baseRange(h: DiffHunk): LineRange | null {
  return h.oldLines > 0 && h.oldStart > 0
    ? { startLine: h.oldStart, endLine: h.oldStart + h.oldLines - 1 }
    : null;
}

export function rangeOf(h: DiffHunk, side: Side): LineRange | null {
  return side === "head" ? headRange(h) : baseRange(h);
}

/** The ref that shows a whole hunk: head side, or base side for pure deletions. */
export function wholeHunkRef(file: ChangeDiffFile, h: DiffHunk): HunkRef {
  const head = headRange(h);
  if (head !== null) return { file: file.path, ...head, side: "head" };
  const base = baseRange(h) ?? { startLine: 1, endLine: 1 };
  return { file: file.path, ...base, side: "base" };
}

export function changedLines(h: DiffHunk): number {
  let n = 0;
  for (const l of h.lines) if (l.kind !== "ctx") n++;
  return n;
}

export function overlaps(a: LineRange, b: LineRange): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/** The diff file a path refers to (head path or rename source), or undefined. */
export function findFile(diff: ChangeDiff, path: string): ChangeDiffFile | undefined {
  const p = normalizePath(path);
  return (
    diff.files.find((f) => normalizePath(f.path) === p) ??
    diff.files.find((f) => f.previousPath !== null && normalizePath(f.previousPath) === p)
  );
}

export type RefCheck =
  | { ok: true; ref: HunkRef; clamped: boolean }
  | { ok: false; reason: "unknown-file" | "outside-hunks" };

/**
 * A ref is kept when it intersects at least one hunk on its side; it is clamped to the span of
 * the hunks it intersects. Reversed ranges are normalized. The file is canonicalized to the
 * diff's (head) path.
 */
export function checkHunkRef(
  diff: ChangeDiff,
  ref: { file: string; startLine: number; endLine: number; side: Side },
): RefCheck {
  const file = findFile(diff, ref.file);
  if (file === undefined) return { ok: false, reason: "unknown-file" };
  const want: LineRange = {
    startLine: Math.min(ref.startLine, ref.endLine),
    endLine: Math.max(ref.startLine, ref.endLine),
  };
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const h of file.hunks) {
    const r = rangeOf(h, ref.side);
    if (r === null || !overlaps(r, want)) continue;
    start = Math.min(start, Math.max(r.startLine, want.startLine));
    end = Math.max(end, Math.min(r.endLine, want.endLine));
  }
  if (!Number.isFinite(start)) return { ok: false, reason: "outside-hunks" };
  const clamped = start !== want.startLine || end !== want.endLine || file.path !== ref.file;
  return {
    ok: true,
    ref: { file: file.path, startLine: start, endLine: end, side: ref.side },
    clamped,
  };
}

// ---------------------------------------------------------------- rendering

const isLockfile = compileGlobs(LOCKFILE_GLOBS, "match-none");

export function isLockfilePath(path: string): boolean {
  return isLockfile(normalizePath(path));
}

/** One hunk, addressed by file and index, with how important it is to keep. */
export interface HunkSlot {
  path: string;
  hunkIndex: number;
  /** 1 = riskiest. */
  rank: number;
  /** True when the hunk has a risk factor beyond its size. */
  hasRisk: boolean;
}

export interface OmittedHunk {
  path: string;
  hunkIndex: number;
  ref: HunkRef;
  changedLines: number;
  why: "budget" | "lockfile";
}

export interface RenderedDiff {
  text: string;
  tokens: number;
  omitted: OmittedHunk[];
  /** Hunks cut short (only the riskiest hunks are ever partially kept). */
  partial: Array<{ path: string; hunkIndex: number; keptLines: number; totalLines: number }>;
}

function lineNo(kind: "add" | "del" | "ctx", oldNo: number | null, newNo: number | null): string {
  if (kind === "add") return `+${newNo ?? "?"}`;
  if (kind === "del") return `-${oldNo ?? "?"}`;
  return ` ${newNo ?? oldNo ?? "?"}`;
}

function rangeLabel(h: DiffHunk): string {
  const head = headRange(h);
  const base = baseRange(h);
  const parts: string[] = [];
  if (head) parts.push(`head ${head.startLine}-${head.endLine}`);
  if (base) parts.push(`base ${base.startLine}-${base.endLine}`);
  return parts.join(" · ");
}

function fileHeader(f: ChangeDiffFile): string {
  const status =
    f.previousPath !== null && f.previousPath !== f.path
      ? `${f.status} from ${f.previousPath}`
      : f.status;
  const notes: string[] = [`${status}`, `+${f.additions} -${f.deletions}`];
  if (f.binary) notes.push("binary, not shown");
  if (f.truncated) notes.push("diff truncated by the platform; only the hunks below were captured");
  return `=== ${f.path} (${notes.join(", ")}) ===`;
}

function hunkHeader(h: DiffHunk, index: number, rank: number | undefined): string {
  const r = rank === undefined ? "" : ` · risk rank ${rank}`;
  // Keep only the section context git prints after "@@ -a,b +c,d @@" (e.g. the function name).
  const context = h.header.replace(/^@@[^@]*@@/, "").trim();
  const header = context === "" ? "" : ` ${context}`;
  return `@@ hunk ${index + 1}${r} · ${rangeLabel(h)} @@${header}`;
}

function hunkBody(h: DiffHunk, keep = h.lines.length): string[] {
  const out = h.lines.slice(0, keep).map((l) => `${lineNo(l.kind, l.oldNo, l.newNo)} ${l.text}`);
  if (keep < h.lines.length) out.push(`… (${h.lines.length - keep} more lines not shown)`);
  return out;
}

function slotKey(path: string, hunkIndex: number): string {
  return `${path}\u0000${hunkIndex}`;
}

/**
 * Render the diff compactly for the model and trim it to `tokenBudget`.
 *
 * Lockfile hunks are always summarized (the dependency evidence describes them). When over
 * budget, hunks are omitted in this order: hunks without any risk factor, largest first; then
 * hunks with risk factors, least risky first. The riskiest hunk is never omitted entirely; if it
 * alone is over budget it is cut short. Every omission is reported so the tour can say so.
 */
export function renderDiff(
  diff: ChangeDiff,
  slots: readonly HunkSlot[],
  tokenBudget: number,
): RenderedDiff {
  const slotByKey = new Map(slots.map((s) => [slotKey(s.path, s.hunkIndex), s]));
  const omitted: OmittedHunk[] = [];
  const partial: RenderedDiff["partial"] = [];

  interface Block {
    path: string;
    hunkIndex: number;
    header: string;
    body: string[];
    tokens: number;
    slot: HunkSlot | undefined;
    hunk: DiffHunk;
    file: ChangeDiffFile;
    dropped: boolean;
  }
  const fileHeaders = new Map<string, string>();
  const blocks: Block[] = [];
  for (const f of diff.files) {
    fileHeaders.set(f.path, fileHeader(f));
    const lock = isLockfilePath(f.path);
    f.hunks.forEach((h, i) => {
      const slot = slotByKey.get(slotKey(f.path, i));
      const header = hunkHeader(h, i, slot?.rank);
      if (lock) {
        omitted.push({
          path: f.path,
          hunkIndex: i,
          ref: wholeHunkRef(f, h),
          changedLines: changedLines(h),
          why: "lockfile",
        });
        const body = [
          `(lockfile hunk, ${changedLines(h)} changed lines, not shown: see the dependencies evidence)`,
        ];
        blocks.push({
          path: f.path,
          hunkIndex: i,
          header,
          body,
          tokens: estimateTokens(body.join("\n")),
          slot,
          hunk: h,
          file: f,
          dropped: true,
        });
        return;
      }
      const body = hunkBody(h);
      blocks.push({
        path: f.path,
        hunkIndex: i,
        header,
        body,
        tokens: estimateTokens(`${header}\n${body.join("\n")}`),
        slot,
        hunk: h,
        file: f,
        dropped: false,
      });
    });
  }

  const headerTokens = estimateTokens([...fileHeaders.values()].join("\n"));
  let total = headerTokens + blocks.reduce((n, b) => n + b.tokens, 0);

  if (total > tokenBudget) {
    const live = blocks.filter((b) => !b.dropped);
    const plain = live
      .filter((b) => !(b.slot?.hasRisk ?? false))
      .sort(
        (a, b) =>
          changedLines(b.hunk) - changedLines(a.hunk) || (b.slot?.rank ?? 0) - (a.slot?.rank ?? 0),
      );
    const risky = live
      .filter((b) => b.slot?.hasRisk ?? false)
      .sort((a, b) => (b.slot?.rank ?? 0) - (a.slot?.rank ?? 0));
    const order = [...plain, ...risky];
    const top =
      order.length > 0
        ? order.reduce((best, b) =>
            (b.slot?.rank ?? Infinity) < (best.slot?.rank ?? Infinity) ? b : best,
          )
        : undefined;
    for (const b of order) {
      if (total <= tokenBudget) break;
      if (b === top) continue;
      const marker = [`(omitted to fit the review budget: ${changedLines(b.hunk)} changed lines)`];
      const tokens = estimateTokens(`${b.header}\n${marker.join("\n")}`);
      total += tokens - b.tokens;
      b.body = marker;
      b.tokens = tokens;
      b.dropped = true;
      omitted.push({
        path: b.path,
        hunkIndex: b.hunkIndex,
        ref: wholeHunkRef(b.file, b.hunk),
        changedLines: changedLines(b.hunk),
        why: "budget",
      });
    }
    if (total > tokenBudget && top !== undefined) {
      // Cut the riskiest hunk short: keep as many leading lines as fit.
      const room = tokenBudget - (total - top.tokens) - estimateTokens(top.header) - 20;
      let keep = 0;
      let used = 0;
      for (const l of top.hunk.lines) {
        const t = estimateTokens(`${lineNo(l.kind, l.oldNo, l.newNo)} ${l.text}\n`);
        if (used + t > room) break;
        used += t;
        keep++;
      }
      keep = Math.max(keep, Math.min(5, top.hunk.lines.length));
      if (keep < top.hunk.lines.length) {
        top.body = hunkBody(top.hunk, keep);
        const tokens = estimateTokens(`${top.header}\n${top.body.join("\n")}`);
        total += tokens - top.tokens;
        top.tokens = tokens;
        partial.push({
          path: top.path,
          hunkIndex: top.hunkIndex,
          keptLines: keep,
          totalLines: top.hunk.lines.length,
        });
      }
    }
  }

  const out: string[] = [];
  for (const f of diff.files) {
    out.push(fileHeaders.get(f.path) ?? f.path);
    for (const b of blocks) {
      if (b.path !== f.path) continue;
      out.push(b.header, ...b.body);
    }
    out.push("");
  }
  const text = out.join("\n").trimEnd();
  return { text, tokens: estimateTokens(text), omitted, partial };
}
