/**
 * The merge queue's conflict resolver in workerd tests (`system:resolver`, never the author): no
 * model calls. A test scripts what the resolver writes for each textual conflict (whole files, as
 * FakeQueueJobs.applyResolution takes them) and how much of it is new; unscripted conflicts are
 * declined, which ejects the Change like a resolver that could not resolve it.
 */
import { conflictResolutionItem } from "@app/evidence";
import type { ConflictResolver, ResolutionOutcome, ResolverInput } from "@app/resolver";

export interface ResolverScript {
  /** The resolved files (null: decline). `ours`/`theirs` are upstream's and the Change's. */
  resolve(input: {
    files: { path: string; base: string | null; ours: string | null; theirs: string | null }[];
  }): Record<string, string | null> | null;
  /** Lines the resolution wrote that are on neither side (> 0 needs a fresh human approval). */
  novelLines?: number;
  /** Lines of either side's change the resolution lost or undid (> 0 needs a fresh approval). */
  droppedLines?: number;
}

interface MergeDoc {
  status: string;
  conflictSha?: string;
  newSha?: string;
  files?: { path: string; base: string | null; ours: string | null; theirs: string | null }[];
}

export class FakeResolver implements ConflictResolver {
  readonly principalId = "system:resolver";
  script: ResolverScript | null = null;
  readonly calls: string[] = [];

  async resolve(input: ResolverInput): Promise<ResolutionOutcome> {
    this.calls.push(input.change.id);
    const merge = input.merge as MergeDoc;
    const files =
      input.semantic === undefined && this.script !== null
        ? this.script.resolve({ files: merge.files ?? [] })
        : null;
    const novelLines = this.script?.novelLines ?? 0;
    const droppedLines = this.script?.droppedLines ?? 0;
    const common = {
      costUsd: 0,
      budgetExceeded: false,
      diagnostics: {
        mode: "textual",
        attempts: 1,
        calls: [],
        problems: [],
        maxOutputTokens: 0,
        diffTokenBudget: 0,
        regenerationReserved: false,
        cutDiffs: 0,
        regions: 1,
      } satisfies ResolutionOutcome["diagnostics"],
    };
    const evidence = conflictResolutionItem({
      upstreamChanges: input.upstream.map((u) => ({ changeId: u.changeId, sha: u.sha })),
      scope: {
        conflictHunks: Object.keys(files ?? {}).map((file) => ({ file, startLine: 1, endLine: 1 })),
        touchesOutsideConflictHunks: false,
        novelLines,
        droppedLines,
      },
      resolutionDiff: files === null ? "" : JSON.stringify(files),
      semanticConflictWith: null,
      rationale: "scripted by the test",
      resolver: { model: "fake", principalId: this.principalId, promptVersion: "test" },
      attempts: 1,
    });
    if (files === null)
      return {
        ...common,
        status: "ejected",
        evidence,
        eject: {
          code: input.semantic === undefined ? "textual-conflict" : "tests-failed",
          cause: input.semantic === undefined ? "declined" : "not-a-conflict",
          message: "the fake resolver has no script for this conflict",
          fix: {
            explanation: "resolve it in a workspace",
            call: `open_workspace({ changeId: "${input.change.id}" })`,
          },
          evidenceRefs: [],
          failingTests: [],
          upstream: input.upstream.map((u) => u.changeId),
        },
      };
    return {
      ...common,
      status: "resolved",
      patch: JSON.stringify({ files }),
      applyOnto: merge.conflictSha ?? merge.newSha ?? "",
      files: Object.entries(files).map(([path, content]) => ({ path, content })),
      scope: {
        files: [],
        conflictHunks: [],
        outsideHunks: [],
        touchesOutsideConflictHunks: false,
        outsideFiles: [],
        unresolvedFiles: [],
        novelLines,
        droppedLines,
        regions: 1,
      },
      evidence,
      semanticConflictWith: null,
      rationale: "scripted by the test",
    };
  }
}
