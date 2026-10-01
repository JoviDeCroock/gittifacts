/**
 * Deterministic hunk risk ranking. Pure: same inputs, same order.
 *
 * Tiers, compared lexicographically (higher is riskier):
 *   0. sensitive  — sensitive-path evidence hit, platform policy file, migration, or any other
 *                   Lane-2 reason whose message names the file
 *   1. api-breaking — a removed/changed public symbol located in the hunk
 *   2. scope-drift  — file outside the plan's scopePaths, or matching an outOfScope glob
 *   3. api-additive — an added public symbol located in the hunk
 *   4. dependency   — manifest hunk with dependency changes (Lane-2 kinds > Lane-1 kinds > patch)
 *   5. uncovered    — changed lines with no coverage (or the file is missing from the report)
 *   6. survivors    — surviving mutants inside the hunk
 *   7. size         — changed lines
 * Ties break on path, then hunk index.
 */
import {
  compileGlobs,
  MIGRATION_GLOBS,
  NON_SOURCE_GLOBS,
  normalizePath,
  PLATFORM_GLOBS,
} from "@app/classifier";
import type { ChangeDiff, ChangeDiffFile, DiffHunk, HunkRef, LaneReason, Plan } from "@app/domain";
import type { ApiChange, EvidenceItem } from "@app/evidence";
import { changedLines, headRange, wholeHunkRef } from "./diff.js";

export type RiskFactorCode =
  | "sensitive-path"
  | "policy-file"
  | "migration"
  | "lane2-reason"
  | "api-breaking"
  | "scope-drift"
  | "api-additive"
  | "dependency"
  | "uncovered-lines"
  | "unmeasured-file"
  | "mutation-survivors";

export interface RiskFactor {
  code: RiskFactorCode;
  /** Short human-readable description ("breaking export formatMoney (declaration)"). */
  detail: string;
  /** Evidence item this factor comes from, if any. */
  evidenceRef?: string;
  /** Classifier reason codes this factor corresponds to (for Lane-2 anchoring). */
  reasonCodes: readonly string[];
  /** Strength within the tier. */
  weight: number;
  /** API factors: the symbols located here. */
  symbols?: readonly string[];
  /** Exact lines to point at (e.g. the declaration), always inside the hunk. */
  focus?: HunkRef;
}

export interface RankedHunk {
  /** 1 = riskiest. */
  rank: number;
  path: string;
  hunkIndex: number;
  /** The whole hunk (head side; base side for pure deletions). */
  ref: HunkRef;
  /** Head- and base-side ranges, for overlap checks. */
  head: { startLine: number; endLine: number } | null;
  base: { startLine: number; endLine: number } | null;
  changedLines: number;
  factors: RiskFactor[];
  /** Tier vector (see module doc). */
  score: readonly number[];
}

export interface RankInput {
  diff: ChangeDiff;
  evidence: readonly EvidenceItem[];
  plan: Plan | null;
  /** Lane reasons from the classifier; Lane-2 reasons naming a file raise it into tier 0. */
  reasons?: readonly LaneReason[];
  /** Paths to leave out (verified-transform files that are collapsed into one stop). */
  exclude?: ReadonlySet<string>;
}

const TIER_OF: Record<RiskFactorCode, number> = {
  "sensitive-path": 0,
  "policy-file": 0,
  migration: 0,
  "lane2-reason": 0,
  "api-breaking": 1,
  "scope-drift": 2,
  "api-additive": 3,
  dependency: 4,
  "uncovered-lines": 5,
  "unmeasured-file": 5,
  "mutation-survivors": 6,
};
const TIERS = 8;

const isPlatformFile = compileGlobs(PLATFORM_GLOBS, "match-all");
const isMigration = compileGlobs(MIGRATION_GLOBS, "match-all");
const isNonSource = compileGlobs(NON_SOURCE_GLOBS, "match-none");

type ItemOf<K extends EvidenceItem["kind"]> = Extract<EvidenceItem, { kind: K }>;
function okItems<K extends EvidenceItem["kind"]>(
  items: readonly EvidenceItem[],
  kind: K,
): ItemOf<K>[] {
  return items.filter((i): i is ItemOf<K> => i.kind === kind && i.status === "ok");
}

function pathsOf(f: ChangeDiffFile): string[] {
  const out = [normalizePath(f.path)];
  if (f.previousPath !== null && normalizePath(f.previousPath) !== out[0])
    out.push(normalizePath(f.previousPath));
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Foo.bar" / "Money#amount" / "default export formatMoney" → the last identifier. */
export function symbolName(symbol: string): string | null {
  const m = /[A-Za-z_$][\w$]*$/.exec(symbol.trim());
  return m ? m[0] : null;
}

interface SymbolHit {
  tier: 3 | 2 | 1; // declaration > export list > mention
  side: "head" | "base";
  line: number;
}

/** Best place a symbol appears among a hunk's changed lines. */
function locateSymbol(
  h: DiffHunk,
  name: string,
  sides: ReadonlySet<"head" | "base">,
): SymbolHit | null {
  const n = escapeRegExp(name);
  const decl = new RegExp(
    `(?:^|[^\\w$])(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum|const|let|var|namespace)\\s+${n}(?![\\w$])`,
  );
  const exportList = new RegExp(
    `export\\s*(?:type\\s*)?\\{[^}]*(?<![\\w$])${n}(?![\\w$])|export\\s+\\*\\s+as\\s+${n}(?![\\w$])`,
  );
  const mention = new RegExp(`(?<![\\w$])${n}(?![\\w$])`);
  let best: SymbolHit | null = null;
  for (const l of h.lines) {
    if (l.kind === "ctx") continue;
    const side = l.kind === "add" ? "head" : "base";
    if (!sides.has(side)) continue;
    const line = side === "head" ? l.newNo : l.oldNo;
    if (line === null) continue;
    const tier = decl.test(l.text) ? 3 : exportList.test(l.text) ? 2 : mention.test(l.text) ? 1 : 0;
    if (tier === 0) continue;
    // Prefer higher tier; at equal tier prefer the head side (the new shape), then the earliest line.
    if (
      best === null ||
      tier > best.tier ||
      (tier === best.tier && side === "head" && best.side === "base")
    ) {
      best = { tier, side, line };
    }
  }
  return best;
}

interface HunkState {
  file: ChangeDiffFile;
  hunk: DiffHunk;
  hunkIndex: number;
  factors: RiskFactor[];
}

function addFactor(state: HunkState, factor: RiskFactor): void {
  state.factors.push(factor);
}

function apiFactors(states: HunkState[], items: readonly EvidenceItem[]): void {
  for (const d of okItems(items, "public-api")) {
    if (d.classification === "none") continue;
    const breaking: Array<{ change: ApiChange; sides: Set<"head" | "base"> }> = [];
    const additive: Array<{ change: ApiChange; sides: Set<"head" | "base"> }> = [];
    for (const pkg of d.packages) {
      for (const c of pkg.removed) breaking.push({ change: c, sides: new Set(["base"]) });
      for (const c of pkg.changed) {
        (d.classification === "breaking" ? breaking : additive).push({
          change: c,
          sides: new Set(["head", "base"]),
        });
      }
      for (const c of pkg.added) additive.push({ change: c, sides: new Set(["head"]) });
    }
    const entries = d.packages.map((p) => normalizePath(p.entry));
    const groups: Array<["api-breaking" | "api-additive", typeof breaking, string]> = [
      ["api-breaking", breaking, "api.breaking"],
      ["api-additive", additive, "api.additive"],
    ];
    for (const [code, list, reasonCode] of groups) {
      // symbol → best hit per hunk
      const perHunk = new Map<HunkState, { symbols: string[]; best: SymbolHit }>();
      for (const { change, sides } of list) {
        const name = symbolName(change.symbol);
        if (name === null) continue;
        let found = false;
        for (const s of states) {
          if (isNonSource(normalizePath(s.file.path))) continue;
          const hit = locateSymbol(s.hunk, name, sides);
          if (hit === null) continue;
          found = true;
          const cur = perHunk.get(s);
          if (cur === undefined) perHunk.set(s, { symbols: [change.symbol], best: hit });
          else {
            if (!cur.symbols.includes(change.symbol)) cur.symbols.push(change.symbol);
            if (hit.tier > cur.best.tier) cur.best = hit;
          }
        }
        if (!found) {
          // Not located in any changed line: fall back to the package entry file's hunks.
          for (const s of states) {
            const p = normalizePath(s.file.path);
            if (
              !entries.some(
                (e) => e !== "" && (p === e || p.endsWith(`/${e}`) || e.endsWith(`/${p}`)),
              )
            )
              continue;
            const cur = perHunk.get(s);
            const fallback: SymbolHit = {
              tier: 1,
              side: headRange(s.hunk) ? "head" : "base",
              line: 0,
            };
            if (cur === undefined) perHunk.set(s, { symbols: [change.symbol], best: fallback });
            else if (!cur.symbols.includes(change.symbol)) cur.symbols.push(change.symbol);
          }
        }
      }
      for (const [s, { symbols, best }] of perHunk) {
        const how = best.tier === 3 ? "declaration" : best.tier === 2 ? "export list" : "mention";
        const label = code === "api-breaking" ? "breaking export" : "new export";
        const factor: RiskFactor = {
          code,
          detail: `${label} ${symbols.join(", ")} (${how})`,
          evidenceRef: d.id,
          reasonCodes: [reasonCode],
          weight: best.tier,
          symbols,
        };
        if (best.line > 0) {
          factor.focus = {
            file: s.file.path,
            startLine: best.line,
            endLine: best.line,
            side: best.side,
          };
        }
        addFactor(s, factor);
      }
    }
  }
}

const DEP_SEVERITY = {
  added: 3,
  major: 3,
  other: 3,
  script: 3,
  minor: 2,
  prerelease: 2,
  removed: 2,
  patch: 1,
} as const;

function dependencyFactors(states: HunkState[], items: readonly EvidenceItem[]): void {
  for (const d of okItems(items, "dependencies")) {
    interface Entry {
      name: string;
      manifest: string;
      severity: number;
      label: string;
      reason: string;
    }
    const entries: Entry[] = [];
    for (const a of d.added)
      entries.push({
        name: a.name,
        manifest: a.manifest,
        severity: DEP_SEVERITY.added,
        label: `added ${a.name}@${a.version}`,
        reason: "dependency.added",
      });
    for (const r of d.removed)
      entries.push({
        name: r.name,
        manifest: r.manifest,
        severity: DEP_SEVERITY.removed,
        label: `removed ${r.name}`,
        reason: "dependency.removed",
      });
    for (const c of d.changed) {
      const sev =
        c.bump === "major"
          ? DEP_SEVERITY.major
          : c.bump === "other"
            ? DEP_SEVERITY.other
            : c.bump === "minor"
              ? DEP_SEVERITY.minor
              : c.bump === "prerelease"
                ? DEP_SEVERITY.prerelease
                : DEP_SEVERITY.patch;
      const reason =
        c.bump === "other"
          ? "dependency.other-bump"
          : c.bump === "patch"
            ? "dependency.patch"
            : `dependency.${c.bump}`;
      entries.push({
        name: c.name,
        manifest: c.manifest,
        severity: sev,
        label: `${c.name} ${c.from} → ${c.to} (${c.bump})`,
        reason,
      });
    }
    for (const s of d.newInstallScripts) {
      if (s.manifest === undefined) continue;
      entries.push({
        name: s.script,
        manifest: s.manifest,
        severity: DEP_SEVERITY.script,
        label: `install script ${s.script}: ${s.command}`,
        reason: "dependency.install-script",
      });
    }
    const byHunk = new Map<HunkState, Entry[]>();
    for (const e of entries) {
      const manifest = normalizePath(e.manifest);
      const inManifest = states.filter((s) => normalizePath(s.file.path) === manifest);
      if (inManifest.length === 0) continue;
      const needle = `"${e.name}"`;
      const mentioning = inManifest.filter((s) =>
        s.hunk.lines.some((l) => l.kind !== "ctx" && l.text.includes(needle)),
      );
      for (const s of mentioning.length > 0 ? mentioning : inManifest) {
        const list = byHunk.get(s) ?? [];
        list.push(e);
        byHunk.set(s, list);
      }
    }
    for (const [s, list] of byHunk) {
      addFactor(s, {
        code: "dependency",
        detail: list.map((e) => e.label).join("; "),
        evidenceRef: d.id,
        reasonCodes: [...new Set(list.map((e) => e.reason))],
        weight: Math.max(...list.map((e) => e.severity)),
      });
    }
  }
}

function coverageFactors(states: HunkState[], items: readonly EvidenceItem[]): void {
  for (const c of okItems(items, "coverage")) {
    const unmeasured = new Set((c.unmeasuredFiles ?? []).map(normalizePath));
    for (const s of states) {
      const path = normalizePath(s.file.path);
      const added = s.hunk.lines
        .filter((l) => l.kind === "add" && l.newNo !== null)
        .map((l) => l.newNo as number);
      if (added.length === 0) continue;
      if (unmeasured.has(path)) {
        addFactor(s, {
          code: "unmeasured-file",
          detail: `file missing from the coverage report (${added.length} added lines)`,
          evidenceRef: c.id,
          reasonCodes: ["coverage.below-threshold", "signal.missing.coverage"],
          weight: added.length,
        });
        continue;
      }
      const entry = c.files.find((f) => normalizePath(f.path) === path);
      if (entry === undefined) continue;
      const uncovered = new Set(entry.uncoveredLines);
      const lines = added.filter((n) => uncovered.has(n));
      if (lines.length === 0) continue;
      const first = Math.min(...lines);
      const last = Math.max(...lines);
      addFactor(s, {
        code: "uncovered-lines",
        detail: `${lines.length} changed line(s) not covered by any test`,
        evidenceRef: c.id,
        reasonCodes: ["coverage.below-threshold"],
        weight: lines.length,
        focus: { file: s.file.path, startLine: first, endLine: last, side: "head" },
      });
    }
  }
}

function mutationFactors(states: HunkState[], items: readonly EvidenceItem[]): void {
  for (const m of okItems(items, "mutation")) {
    for (const s of states) {
      const range = headRange(s.hunk);
      if (range === null) continue;
      const path = normalizePath(s.file.path);
      const here = m.survivors.filter(
        (v) =>
          normalizePath(v.file) === path && v.line >= range.startLine && v.line <= range.endLine,
      );
      if (here.length === 0) continue;
      addFactor(s, {
        code: "mutation-survivors",
        detail: `${here.length} surviving mutant(s): ${here
          .slice(0, 3)
          .map((v) => `line ${v.line} ${v.mutator}`)
          .join(", ")}`,
        evidenceRef: m.id,
        reasonCodes: ["mutation.below-threshold"],
        weight: here.length,
      });
    }
  }
}

function pathFactors(states: HunkState[], input: RankInput): void {
  const hits = new Map<string, { id: string; pattern: string }>();
  for (const s of okItems(input.evidence, "sensitive-paths")) {
    for (const h of s.hits)
      if (!hits.has(normalizePath(h.path)))
        hits.set(normalizePath(h.path), { id: s.id, pattern: h.pattern });
  }
  const plan = input.plan;
  const inScope =
    plan && plan.scopePaths.length > 0 ? compileGlobs(plan.scopePaths, "match-none") : null;
  const outGlobs = (plan?.outOfScope ?? []).filter((e) => e.includes("/") || e.includes("*"));
  const outOfScope = outGlobs.length > 0 ? compileGlobs(outGlobs, "match-all") : null;
  const lane2 = (input.reasons ?? []).filter((r) => r.lane === 2);

  for (const s of states) {
    const paths = pathsOf(s.file);
    for (const p of paths) {
      const hit = hits.get(p);
      if (hit) {
        addFactor(s, {
          code: "sensitive-path",
          detail: `sensitive path (${hit.pattern})`,
          evidenceRef: hit.id,
          reasonCodes: ["sensitive.hit"],
          weight: 3,
        });
        break;
      }
    }
    if (paths.some((p) => isPlatformFile(p))) {
      addFactor(s, {
        code: "policy-file",
        detail: "platform policy/config under .platform/",
        reasonCodes: ["policy.changed"],
        weight: 3,
      });
    }
    if (paths.some((p) => isMigration(p))) {
      addFactor(s, {
        code: "migration",
        detail: "database migration",
        reasonCodes: ["migration.touched"],
        weight: 3,
      });
    }
    if (inScope !== null && paths.some((p) => !inScope(p))) {
      addFactor(s, {
        code: "scope-drift",
        detail: "outside the plan's scopePaths",
        reasonCodes: ["scope.drift"],
        weight: 2,
      });
    }
    if (outOfScope !== null && paths.some((p) => outOfScope(p))) {
      addFactor(s, {
        code: "scope-drift",
        detail: "matches the plan's outOfScope",
        reasonCodes: ["scope.out-of-scope"],
        weight: 2,
      });
    }
    // Any other Lane-2 reason that names this file (e.g. a sensitive glob from the base policy).
    for (const r of lane2) {
      if (!paths.some((p) => mentionsPath(r.message, p))) continue;
      if (s.factors.some((f) => f.reasonCodes.includes(r.code))) continue;
      const code: RiskFactorCode = r.code.startsWith("scope.") ? "scope-drift" : "lane2-reason";
      const factor: RiskFactor = {
        code,
        detail: r.message,
        reasonCodes: [r.code],
        weight: code === "scope-drift" ? 2 : 3,
      };
      if (r.evidenceRef !== undefined) factor.evidenceRef = r.evidenceRef;
      addFactor(s, factor);
    }
  }
}

function mentionsPath(message: string, path: string): boolean {
  return new RegExp(`(?:^|[\\s,:;(\`'"])${escapeRegExp(path)}(?=$|[\\s,.;:)\`'"])`).test(message);
}

function scoreOf(factors: readonly RiskFactor[], size: number): number[] {
  const score = new Array<number>(TIERS).fill(0);
  for (const f of factors) {
    const tier = TIER_OF[f.code];
    // Tier 0 counts distinct facts; the others keep the strongest weight (counts add up).
    if (tier === 0) score[tier] = (score[tier] ?? 0) + f.weight;
    else if (tier === 5 || tier === 6) score[tier] = (score[tier] ?? 0) + f.weight;
    else score[tier] = Math.max(score[tier] ?? 0, f.weight);
  }
  score[TIERS - 1] = size;
  return score;
}

function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Rank every hunk of every non-excluded file. Rank 1 is the riskiest. */
export function rankHunks(input: RankInput): RankedHunk[] {
  const states: HunkState[] = [];
  for (const file of input.diff.files) {
    if (input.exclude?.has(file.path)) continue;
    file.hunks.forEach((hunk, hunkIndex) => {
      states.push({ file, hunk, hunkIndex, factors: [] });
    });
  }
  pathFactors(states, input);
  apiFactors(states, input.evidence);
  dependencyFactors(states, input.evidence);
  coverageFactors(states, input.evidence);
  mutationFactors(states, input.evidence);

  const ranked = states.map((s) => {
    const size = changedLines(s.hunk);
    const head = headRange(s.hunk);
    const base =
      s.hunk.oldLines > 0 && s.hunk.oldStart > 0
        ? { startLine: s.hunk.oldStart, endLine: s.hunk.oldStart + s.hunk.oldLines - 1 }
        : null;
    return {
      rank: 0,
      path: s.file.path,
      hunkIndex: s.hunkIndex,
      ref: wholeHunkRef(s.file, s.hunk),
      head,
      base,
      changedLines: size,
      factors: s.factors,
      score: scoreOf(s.factors, size),
    } satisfies RankedHunk;
  });
  ranked.sort(
    (a, b) =>
      compareScores(a.score, b.score) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.hunkIndex - b.hunkIndex,
  );
  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });
  return ranked;
}

/** True when the hunk has a risk factor beyond its size. */
export function hasRisk(h: RankedHunk): boolean {
  return h.factors.length > 0;
}

/**
 * The Lane-2 classifier reason a candidate is anchored to, if any: a Lane-2 reason whose code is
 * one of a factor's reason codes and whose evidenceRef (when both sides have one) matches.
 */
export function lane2Anchor(
  candidate: RankedHunk,
  reasons: readonly LaneReason[],
): { reason: LaneReason; factor: RiskFactor } | null {
  for (const factor of candidate.factors) {
    for (const reason of reasons) {
      if (reason.lane !== 2 || !factor.reasonCodes.includes(reason.code)) continue;
      if (
        reason.evidenceRef !== undefined &&
        factor.evidenceRef !== undefined &&
        reason.evidenceRef !== factor.evidenceRef
      ) {
        continue;
      }
      return { reason, factor };
    }
  }
  return null;
}

/** Does `ref` point into this candidate's hunk (same file, overlapping lines on its side)? */
export function refHitsCandidate(ref: HunkRef, candidate: RankedHunk): boolean {
  if (normalizePath(ref.file) !== normalizePath(candidate.path)) return false;
  const range = ref.side === "base" ? candidate.base : candidate.head;
  return range !== null && ref.startLine <= range.endLine && range.startLine <= ref.endLine;
}
