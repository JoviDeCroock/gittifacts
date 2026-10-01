/**
 * Path rules: files whose dependents are known from their path alone.
 * - documentation and repository metadata: nothing depends on them;
 * - `__snapshots__/x.test.ts.snap`: its test (edge test → snapshot);
 * - configuration: handled by the `*config*` sentinel, so understood here.
 */
import { isConfigFile, isDocFile, isMetaFile, snapshotOwner } from "../classify.js";
import type { Analyzer, AnalyzerContext, Edge, PartialGraph } from "../types.js";

export const PATH_RULES_NAME = "path-rules";
export const PATH_RULES_VERSION = "1.0.0";

export function pathRulesAnalyzer(): Analyzer {
  return {
    name: PATH_RULES_NAME,
    version: PATH_RULES_VERSION,
    supports: () => true,
    reads: () => false,
    analyze(ctx: AnalyzerContext): PartialGraph {
      const present = new Set(ctx.tree.files);
      const edges: Edge[] = [];
      const owned = new Set<string>();
      for (const f of [...ctx.tree.files, ...ctx.deleted]) {
        const owner = snapshotOwner(f);
        if (owner !== null && present.has(owner)) {
          edges.push({ from: owner, to: f });
          owned.add(f);
        }
      }
      return {
        edges,
        understands: (path) =>
          isDocFile(path) || isMetaFile(path) || isConfigFile(path) || owned.has(path),
        scanned: 0,
        complete: true,
        notes: [],
      };
    },
  };
}
