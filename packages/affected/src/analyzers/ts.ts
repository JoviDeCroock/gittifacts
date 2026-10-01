/**
 * The TS/JS analyzer: scans every module-like file of the tree (JS/TS, Vue/Svelte/Astro/MDX
 * components, HTML `src`/`href`, stylesheet `@import`/`url()`), resolves each reference to a
 * repo file and returns the edges.
 *
 * Holes it cannot close are reported, never guessed:
 * - a local workspace package whose entry cannot be mapped to a file, and path aliases
 *   (`@/x`, `~/x`) nothing resolves: edges into that package may be missing, so a closure that
 *   reaches it is incomplete (see `holes`);
 * - fully computed `import(x)` / `require(x)`: counted in the notes (they load runtime paths in
 *   practice; a coverage map sees through them);
 * - relative specifiers to files that are not in the tree (generated, gitignored): harmless for
 *   the closure, since no change can touch such a file; counted in the notes.
 */
import {
  isConfigFile,
  isMarkupFile,
  isScannedFile,
  isStyleFile,
  isTestRunnerConfig,
} from "../classify.js";
import { dirOf, escapeRegExp, globToRegExp, joinPath } from "../paths.js";
import { type FileSet, Resolver } from "../resolve.js";
import { relativeStringLiterals, scanModule, type TemplateGlob } from "../scan.js";
import type { Analyzer, AnalyzerContext, Edge, PartialGraph } from "../types.js";

export const TS_ANALYZER_NAME = "ts-js";
export const TS_ANALYZER_VERSION = "1.0.0";

/** Larger files (bundles, generated data) are not scanned; they are counted in the notes. */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024;

export interface TsPartialGraph extends PartialGraph {
  /** Resolved dependencies of one version of a file (used to diff base vs head of touched files). */
  edgesFor(path: string, content: string): string[];
  /**
   * Package directories with unresolvable incoming references (an aliased or local-package
   * import that maps to no file). A closure that reaches into one of them may be missing
   * importers.
   */
  holes: ReadonlyMap<string, string>;
  resolver: Resolver;
}

const HTML_REF = /\b(?:src|href)\s*=\s*["']([^"'#?]+)[^"']*["']/g;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']([^"']+)["']/g;
const CSS_URL = /url\(\s*["']?([^"')?#]+)[^"')]*["']?\s*\)/g;

function isRelativeOrRoot(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
}

export function tsAnalyzer(): Analyzer & { analyze(ctx: AnalyzerContext): TsPartialGraph } {
  return {
    name: TS_ANALYZER_NAME,
    version: TS_ANALYZER_VERSION,
    supports: (files) => files.some(isScannedFile),
    reads: (path) =>
      isScannedFile(path) ||
      path === "package.json" ||
      path.endsWith("/package.json") ||
      /(?:^|\/)(?:ts|js)config(?:\..*)?\.json$/.test(path),
    analyze(ctx: AnalyzerContext): TsPartialGraph {
      const files = ctx.tree.files;
      const resolver = new Resolver({ files, read: (p) => ctx.tree.read(p) });
      const deleted: FileSet = ctx.deleted;
      const holes = new Map<string, string>();
      let opaque = 0;
      let missingRelative = 0;
      let tooLarge = 0;
      let unreadable = 0;
      const opaqueExamples: string[] = [];

      const markHole = (from: string, spec: string, why: string): void => {
        const pkg = resolver.packageOf(from)?.dir ?? "";
        const target = resolver.isLocalPackageSpecifier(spec)
          ? (findPackageDir(resolver, spec) ?? pkg)
          : pkg;
        if (!holes.has(target)) holes.set(target, `${from}: ${why} "${spec}"`);
      };

      const resolveSpec = (from: string, spec: string, out: Set<string>): void => {
        let hits = resolver.resolve(from, spec);
        if (hits === null || hits.length === 0) {
          const fallback = resolver.resolve(from, spec, deleted);
          if (fallback !== null && fallback.length > 0) hits = fallback;
        }
        if (hits === null) {
          if (isRelativeOrRoot(spec)) missingRelative++;
          else markHole(from, spec, "unresolved");
          return;
        }
        if (hits.length === 0 && Resolver.looksLikeAlias(spec)) {
          markHole(from, spec, "unresolved alias");
          return;
        }
        for (const h of hits) out.add(h);
      };

      const matchFiles = (re: RegExp, prefix: string, out: Set<string>): void => {
        for (const f of files) if (f.startsWith(prefix) && re.test(f)) out.add(f);
      };

      const templateTargets = (from: string, t: TemplateGlob, out: Set<string>): void => {
        const first = t.parts[0] ?? "";
        const cut = first.lastIndexOf("/");
        const dir = joinPath(dirOf(from), first.slice(0, cut + 1));
        if (dir === null) return;
        const rest = first.slice(cut + 1);
        let src = `^${escapeRegExp(dir === "" ? "" : `${dir}/`)}${escapeRegExp(rest)}`;
        for (let i = 1; i < t.parts.length; i++) {
          let part = t.parts[i] ?? "";
          let ext = "";
          if (i === t.parts.length - 1) {
            const m = /\.(?:[cm]?js|jsx)$/.exec(part);
            if (m !== null) {
              part = part.slice(0, m.index);
              ext = "\\.(?:[cm]?[jt]sx?|d\\.ts)";
            }
          }
          src += `.*${escapeRegExp(part)}${ext}`;
        }
        const last = t.parts[t.parts.length - 1] ?? "";
        if (!/\.[\w]+$/.test(last)) src += "(?:\\.[^/]+|/index\\.[^/]+)?";
        matchFiles(new RegExp(`${src}$`), dir === "" ? "" : `${dir}/`, out);
      };

      const globTargets = (from: string, pattern: string, out: Set<string>): void => {
        if (pattern.startsWith("!")) return;
        let full: string | null;
        if (pattern.startsWith("/")) {
          full = joinPath(resolver.packageOf(from)?.dir ?? "", pattern);
        } else if (isRelativeOrRoot(pattern)) {
          full = joinPath(dirOf(from), pattern);
        } else {
          markHole(from, pattern, "unresolvable glob");
          return;
        }
        if (full === null) return;
        const staticPrefix = full.slice(
          0,
          full.search(/[*?{[]/) === -1 ? full.length : full.search(/[*?{[]/),
        );
        const prefixDir = staticPrefix.slice(0, staticPrefix.lastIndexOf("/") + 1);
        matchFiles(globToRegExp(full), prefixDir, out);
      };

      const edgesFor = (path: string, content: string): string[] => {
        const out = new Set<string>();
        if (isMarkupFile(path)) {
          for (const m of content.matchAll(HTML_REF)) {
            const spec = m[1];
            if (spec === undefined || /^[a-z]+:|^\/\//i.test(spec)) continue;
            const s = isRelativeOrRoot(spec) ? spec : `./${spec}`;
            const hits = resolver.resolve(path, s) ?? resolver.resolve(path, s, deleted);
            for (const h of hits ?? []) out.add(h);
          }
        } else if (isStyleFile(path)) {
          for (const re of [CSS_IMPORT, CSS_URL]) {
            for (const m of content.matchAll(re)) {
              const spec = m[1]?.trim();
              if (spec === undefined || spec === "" || /^[a-z]+:|^\/\//i.test(spec)) continue;
              const s =
                isRelativeOrRoot(spec) || spec.startsWith("@") || spec.startsWith("~")
                  ? spec.replace(/^~/, "")
                  : `./${spec}`;
              const hits = resolver.resolve(path, s) ?? resolver.resolve(path, s, deleted);
              for (const h of hits ?? []) out.add(h);
            }
          }
        } else {
          const scan = scanModule(content);
          for (const ref of scan.refs) {
            if (ref.kind === "glob") globTargets(path, ref.specifier, out);
            else resolveSpec(path, ref.specifier, out);
          }
          for (const t of scan.templates) templateTargets(path, t, out);
          if (scan.opaque.length > 0) {
            opaque += scan.opaque.length;
            if (opaqueExamples.length < 3) opaqueExamples.push(`${path}:${scan.opaque[0]?.line}`);
          }
          if (isTestRunnerConfig(path)) {
            // setupFiles / globalSetup / include roots: string literals that name files.
            for (const lit of relativeStringLiterals(content)) {
              const target = joinPath(dirOf(path), lit);
              if (target === null) continue;
              const hit = resolver.resolveFile(target);
              if (hit !== null) out.add(hit);
            }
          }
        }
        out.delete(path);
        return [...out];
      };

      const edges: Edge[] = [];
      let scanned = 0;
      for (const file of files) {
        if (!isScannedFile(file)) continue;
        const content = ctx.tree.read(file);
        if (content === null) {
          unreadable++;
          continue;
        }
        if (content.length > MAX_SCAN_BYTES) {
          tooLarge++;
          continue;
        }
        scanned++;
        for (const to of edgesFor(file, content)) edges.push({ from: file, to });
      }

      const notes: string[] = [`scanned ${scanned} files, ${edges.length} edges`];
      if (holes.size > 0)
        notes.push(
          `unresolved local references in ${holes.size} package(s): ${[...holes.values()].slice(0, 3).join("; ")}`,
        );
      if (opaque > 0)
        notes.push(
          `${opaque} computed import()/require() not followed (${opaqueExamples.join(", ")})`,
        );
      if (missingRelative > 0)
        notes.push(`${missingRelative} relative import(s) of files not in the tree (generated?)`);
      if (tooLarge > 0) notes.push(`${tooLarge} file(s) over ${MAX_SCAN_BYTES} bytes not scanned`);
      if (unreadable > 0) notes.push(`${unreadable} file(s) unreadable`);
      if (resolver.diagnostics.badConfigs.length > 0)
        notes.push(`unparseable config: ${resolver.diagnostics.badConfigs.slice(0, 5).join(", ")}`);

      return {
        edges,
        understands: (path) => isScannedFile(path) && !isConfigFile(path),
        scanned,
        // A scanned-type file we could not read may hide any edge; one we chose not to scan
        // (over MAX_SCAN_BYTES: bundles, generated data) is noted only.
        complete: unreadable === 0,
        notes,
        edgesFor,
        holes,
        resolver,
      };
    },
  };
}

function findPackageDir(resolver: Resolver, spec: string): string | null {
  for (const pkg of resolver.packages.values()) {
    if (pkg.name !== null && (spec === pkg.name || spec.startsWith(`${pkg.name}/`))) return pkg.dir;
  }
  return null;
}
