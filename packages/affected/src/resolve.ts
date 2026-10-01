/**
 * Module specifier resolution over a repository tree, without node_modules:
 *
 * - relative and root-absolute specifiers, with TypeScript's extension rules
 *   (`./x.js` → `x.ts`, extensionless → `.ts/.tsx/.mts/.cts/.d.ts/.js/.jsx/.mjs/.cjs/.json`,
 *   directories → `index.*` or their package.json entry);
 * - tsconfig/jsconfig `paths` and `baseUrl` (with `extends` chains inside the repo);
 * - package.json `imports` (`#internal/*`) of the importer's package;
 * - workspace packages by name: `exports` (subpaths, `*` patterns, every condition), else
 *   `main`/`module`/`types`/`source`; built targets (`dist/x.js`) are mapped back to sources
 *   through tsconfig `outDir`/`rootDir` or the usual `dist|build|lib|out` → `src` layout.
 *
 * Anything else (npm dependencies, node builtins) is external: no edge.
 */
import { z } from "zod";
import { parseJsonc } from "./jsonc.js";
import { ancestors, baseName, dirOf, isUnder, joinPath } from "./paths.js";

export interface FileSet {
  has(path: string): boolean;
}

const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".vue",
  ".svelte",
];

/** `./x.js` written in TS source means `./x.ts` (or tsx, or the .js itself). */
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx"],
  ".mjs": [".mts", ".d.mts"],
  ".cjs": [".cts", ".d.cts"],
};

const Manifest = z
  .object({
    name: z.string().optional(),
    main: z.string().optional(),
    module: z.string().optional(),
    types: z.string().optional(),
    typings: z.string().optional(),
    source: z.string().optional(),
    exports: z.unknown().optional(),
    imports: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
type Manifest = z.infer<typeof Manifest>;

const TsConfig = z
  .object({
    extends: z.union([z.string(), z.array(z.string())]).optional(),
    compilerOptions: z
      .object({
        baseUrl: z.string().optional(),
        paths: z.record(z.string(), z.array(z.string())).optional(),
        outDir: z.string().optional(),
        rootDir: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface PackageInfo {
  /** Repo-relative directory ("" for the root package). */
  dir: string;
  name: string | null;
  manifest: Manifest;
}

interface PathsConfig {
  /** Directory the `paths` targets are relative to. */
  base: string;
  paths: Record<string, string[]>;
  /** baseUrl directory, when set. */
  baseUrl: string | null;
}

interface OutDirMapping {
  outDir: string;
  rootDir: string;
}

export interface ResolverOptions {
  /** Every file in the tree. */
  files: readonly string[];
  /** Content of config files (package.json, tsconfig*.json); null when absent/unreadable. */
  read(path: string): string | null;
}

export interface ResolveDiagnostics {
  /** Config files that could not be parsed. */
  badConfigs: string[];
}

const NODE_BUILTIN =
  /^(?:node:|bun:|cloudflare:|virtual:|workerd:|(?:assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(?:\/|$))/;

export function isBuiltinSpecifier(spec: string): boolean {
  return NODE_BUILTIN.test(spec);
}

function stripQuery(spec: string): string {
  const q = spec.indexOf("?");
  return q === -1 ? spec : spec.slice(0, q);
}

/** All string targets of an exports/imports condition tree (every condition, arrays flattened). */
function targetsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) targetsOf(v, out);
  else if (value !== null && typeof value === "object")
    for (const v of Object.values(value as Record<string, unknown>)) targetsOf(v, out);
  return out;
}

/** Match `subpath` against an exports/imports map; returns the targets with `*` substituted. */
export function matchSubpathMap(map: Record<string, unknown>, subpath: string): string[] | null {
  if (Object.hasOwn(map, subpath)) return targetsOf(map[subpath]);
  let best: { key: string; prefixLen: number; star: string; pattern: boolean } | null = null;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star === -1) {
      // Legacy folder mappings: "./features/": "./src/features/"
      if (key.endsWith("/") && subpath.startsWith(key)) {
        if (best === null || key.length > best.prefixLen)
          best = { key, prefixLen: key.length, star: subpath.slice(key.length), pattern: false };
      }
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.length >= prefix.length + suffix.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      (best === null || prefix.length > best.prefixLen)
    ) {
      best = {
        key,
        prefixLen: prefix.length,
        star: subpath.slice(prefix.length, subpath.length - suffix.length),
        pattern: true,
      };
    }
  }
  if (best === null) return null;
  const { key, star, pattern } = best;
  return targetsOf(map[key]).map((t) => (pattern ? t.split("*").join(star) : t + star));
}

/** Is an `exports` value a subpath map (keys start with ".") rather than conditions? */
function isSubpathMap(exp: unknown): exp is Record<string, unknown> {
  if (exp === null || typeof exp !== "object" || Array.isArray(exp)) return false;
  const keys = Object.keys(exp);
  return keys.length > 0 && keys.every((k) => k.startsWith("."));
}

export class Resolver {
  private readonly files: FileSet;
  private readonly fileList: readonly string[];
  private readonly read: (path: string) => string | null;
  /** Package by directory. */
  readonly packages = new Map<string, PackageInfo>();
  /** Packages by name (a name may occur more than once: fixtures, templates). */
  private readonly byName = new Map<string, PackageInfo[]>();
  private readonly pathsCache = new Map<string, PathsConfig[]>();
  private readonly tsconfigCache = new Map<string, z.infer<typeof TsConfig> | null>();
  private readonly outDirCache = new Map<string, OutDirMapping[]>();
  private readonly tsconfigDirs = new Map<string, string[]>();
  /** Recursion guard: package directories whose entry is being resolved. */
  private readonly enteringPackages = new Set<string>();
  readonly diagnostics: ResolveDiagnostics = { badConfigs: [] };

  constructor(opts: ResolverOptions) {
    this.fileList = opts.files;
    const set = new Set(opts.files);
    this.files = set;
    this.read = opts.read;
    for (const f of opts.files) {
      const base = baseName(f);
      if (base === "package.json" && !f.includes("node_modules/")) {
        const parsed = Manifest.safeParse(parseJsonc(this.read(f) ?? ""));
        if (!parsed.success) {
          this.diagnostics.badConfigs.push(f);
          continue;
        }
        const info: PackageInfo = {
          dir: dirOf(f),
          name: parsed.data.name ?? null,
          manifest: parsed.data,
        };
        this.packages.set(info.dir, info);
        if (info.name !== null) {
          const list = this.byName.get(info.name);
          if (list === undefined) this.byName.set(info.name, [info]);
          else list.push(info);
        }
      } else if (/^(?:tsconfig|jsconfig)(?:\..*)?\.json$/.test(base)) {
        const dir = dirOf(f);
        const list = this.tsconfigDirs.get(dir);
        if (list === undefined) this.tsconfigDirs.set(dir, [f]);
        else list.push(f);
      }
    }
    for (const list of this.tsconfigDirs.values())
      list.sort((a, b) => {
        // tsconfig.json / jsconfig.json first, then the variants.
        const ra = /\/?(?:ts|js)config\.json$/.test(a) ? 0 : 1;
        const rb = /\/?(?:ts|js)config\.json$/.test(b) ? 0 : 1;
        return ra - rb || (a < b ? -1 : 1);
      });
  }

  /** Every file in the tree (sorted as given). */
  allFiles(): readonly string[] {
    return this.fileList;
  }

  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  /** The package whose directory most closely contains `path`. */
  packageOf(path: string): PackageInfo | null {
    for (const dir of ancestors(path)) {
      const p = this.packages.get(dir);
      if (p !== undefined) return p;
    }
    return null;
  }

  /**
   * Resolve `spec` imported from `from` to repo files. `exists` decides which files count
   * (head files, or deleted files as a fallback). Returns [] for external specifiers and
   * null when a local-looking specifier could not be resolved.
   */
  resolve(from: string, rawSpec: string, exists: FileSet = this.files): string[] | null {
    const spec = stripQuery(rawSpec);
    if (spec === "") return null;
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
      const target = joinPath(dirOf(from), spec);
      if (target === null) return null;
      const hit =
        this.resolveFile(target, exists) ??
        this.fromBuilt(target, this.packageOf(target)?.dir ?? "", exists);
      return hit === null ? null : [hit];
    }
    if (spec.startsWith("/")) {
      // Root-absolute (vite, worker assets): the importer's package root, then the repo root.
      const pkg = this.packageOf(from);
      for (const root of pkg === null ? [""] : [pkg.dir, ""]) {
        const target = joinPath(root, spec);
        if (target === null) continue;
        const hit = this.resolveFile(target, exists);
        if (hit !== null) return [hit];
      }
      return null;
    }
    if (spec.startsWith("#")) return this.resolveImportsField(from, spec, exists);
    if (isBuiltinSpecifier(spec)) return [];

    const viaPaths = this.resolveTsPaths(from, spec, exists);
    if (viaPaths !== null) return viaPaths;

    const viaPackage = this.resolvePackageSpecifier(spec, exists);
    if (viaPackage !== null) return viaPackage;
    // A local package that maps to nothing is a resolution failure, not an npm dependency.
    return this.isLocalPackageSpecifier(spec) ? null : [];
  }

  /** A local workspace package name is imported (resolved or not). */
  isLocalPackageSpecifier(spec: string): boolean {
    const { name } = splitPackageSpecifier(stripQuery(spec));
    return name !== null && this.byName.has(name);
  }

  /** Looks like a path alias (`@/x`, `~/x`) that nothing resolved. */
  static looksLikeAlias(spec: string): boolean {
    return /^(?:[@~]\/|\$[a-z]+\/)/.test(spec);
  }

  // ---------------------------------------------------------------- files

  resolveFile(target: string, exists: FileSet = this.files): string | null {
    if (exists.has(target)) return target;
    const dot = target.lastIndexOf(".");
    const slash = target.lastIndexOf("/");
    if (dot > slash) {
      const ext = target.slice(dot);
      const swaps = JS_TO_TS[ext];
      if (swaps !== undefined) {
        const stem = target.slice(0, dot);
        for (const s of swaps) if (exists.has(stem + s)) return stem + s;
      }
    }
    for (const ext of RESOLVE_EXTENSIONS) if (exists.has(target + ext)) return target + ext;
    // Directory: its package.json entry, else index.*
    const pkg = this.packages.get(target);
    if (pkg !== undefined && target !== "" && !this.enteringPackages.has(target)) {
      this.enteringPackages.add(target);
      try {
        const entry = this.packageEntry(pkg, ".", exists);
        if (entry !== null && entry.length > 0) return entry[0] ?? null;
      } finally {
        this.enteringPackages.delete(target);
      }
    }
    const prefix = target === "" ? "index" : `${target}/index`;
    for (const ext of RESOLVE_EXTENSIONS) if (exists.has(prefix + ext)) return prefix + ext;
    return null;
  }

  // ---------------------------------------------------------------- packages

  private resolvePackageSpecifier(spec: string, exists: FileSet): string[] | null {
    const { name, subpath } = splitPackageSpecifier(spec);
    if (name === null) return null;
    const candidates = this.byName.get(name);
    if (candidates === undefined) return null;
    const out: string[] = [];
    for (const pkg of candidates) {
      const hit = this.packageEntry(pkg, subpath, exists);
      if (hit !== null) out.push(...hit);
    }
    // A local package whose entry cannot be mapped to a file is a resolution failure, not external.
    return out.length > 0 ? [...new Set(out)] : null;
  }

  /** Files a package subpath ("." or "./x") maps to. */
  packageEntry(pkg: PackageInfo, subpath: string, exists: FileSet = this.files): string[] | null {
    const m = pkg.manifest;
    let targets: string[] | null = null;
    if (m.exports !== undefined && m.exports !== null) {
      if (isSubpathMap(m.exports)) targets = matchSubpathMap(m.exports, subpath);
      else if (subpath === ".") targets = targetsOf(m.exports);
      else targets = null;
      if (targets === null) return null;
    } else if (subpath === ".") {
      targets = [m.source, m.module, m.main, m.types, m.typings].filter(
        (t): t is string => typeof t === "string",
      );
      if (targets.length === 0) targets = ["./index", "./src/index"];
    } else {
      targets = [subpath];
    }
    const out: string[] = [];
    for (const t of targets) {
      const hit = this.mapTarget(pkg.dir, t, exists);
      if (hit !== null) out.push(hit);
    }
    if (out.length === 0 && subpath === ".") {
      const fallback = this.resolveFile(joinPath(pkg.dir, "src/index") ?? "src/index", exists);
      if (fallback !== null) out.push(fallback);
    }
    if (out.length === 0 && subpath !== "." && m.exports === undefined) {
      const viaSrc = this.resolveFile(joinPath(pkg.dir, "src", subpath) ?? "", exists);
      if (viaSrc !== null) out.push(viaSrc);
    }
    return out.length > 0 ? [...new Set(out)] : null;
  }

  /** A declared package target (possibly a build output) → a file in the tree. */
  private mapTarget(pkgDir: string, target: string, exists: FileSet): string | null {
    if (!target.startsWith("./") && !target.startsWith("../") && target !== ".") {
      // exports targets must be relative; `main` may omit "./".
      if (target.includes(":")) return null;
    }
    const full = joinPath(pkgDir, target);
    if (full === null) return null;
    const direct = this.resolveFile(full, exists);
    if (direct !== null) return direct;
    return this.fromBuilt(full, pkgDir, exists);
  }

  /** A build output path (`pkg/dist/x.js`, `pkg/dist/x.d.ts`) → the source it is built from. */
  fromBuilt(full: string, pkgDir: string, exists: FileSet = this.files): string | null {
    const stem = full.replace(/\.d\.[cm]?ts$/, "").replace(/\.[cm]?js$/, "");
    for (const { outDir, rootDir } of this.outDirMappings(pkgDir)) {
      if (isUnder(stem, outDir) && stem !== outDir) {
        const rel = stem.slice(outDir === "" ? 0 : outDir.length + 1);
        const mapped = joinPath(rootDir, rel);
        if (mapped !== null) {
          const hit = this.resolveFile(mapped, exists);
          if (hit !== null) return hit;
        }
      }
    }
    const rel = pkgDir === "" ? stem : stem.slice(pkgDir.length + 1);
    const m = /^(?:dist|build|lib|out|esm|cjs)(?:\/(?:esm|cjs|types|src))?\/(.*)$/.exec(rel);
    if (m !== null && m[1] !== undefined) {
      const mapped = joinPath(pkgDir, "src", m[1]);
      if (mapped !== null) {
        const hit = this.resolveFile(mapped, exists);
        if (hit !== null) return hit;
      }
    }
    return null;
  }

  private outDirMappings(pkgDir: string): OutDirMapping[] {
    const cached = this.outDirCache.get(pkgDir);
    if (cached !== undefined) return cached;
    const out: OutDirMapping[] = [];
    for (const file of this.tsconfigDirs.get(pkgDir) ?? []) {
      const opts = this.effectiveCompilerOptions(file);
      if (opts.outDir !== undefined) {
        const outDir = joinPath(pkgDir, opts.outDir);
        const rootDir = joinPath(pkgDir, opts.rootDir ?? "src");
        if (outDir !== null && rootDir !== null) out.push({ outDir, rootDir });
      }
    }
    this.outDirCache.set(pkgDir, out);
    return out;
  }

  private resolveImportsField(from: string, spec: string, exists: FileSet): string[] | null {
    const pkg = this.packageOf(from);
    const imports = pkg?.manifest.imports;
    if (pkg === null || imports === undefined) return null;
    const targets = matchSubpathMap(imports, spec);
    if (targets === null) return null;
    const out: string[] = [];
    for (const t of targets) {
      if (t.startsWith("./")) {
        const hit = this.mapTarget(pkg.dir, t, exists);
        if (hit !== null) out.push(hit);
      } else {
        const hit = this.resolvePackageSpecifier(t, exists);
        if (hit !== null) out.push(...hit);
        else return [];
      }
    }
    return out.length > 0 ? out : null;
  }

  // ---------------------------------------------------------------- tsconfig

  private loadTsconfig(file: string): z.infer<typeof TsConfig> | null {
    if (this.tsconfigCache.has(file)) return this.tsconfigCache.get(file) ?? null;
    const text = this.read(file);
    const parsed = text === null ? null : TsConfig.safeParse(parseJsonc(text));
    const value = parsed?.success ? parsed.data : null;
    if (text !== null && value === null) this.diagnostics.badConfigs.push(file);
    this.tsconfigCache.set(file, value);
    return value;
  }

  /** `extends` target of a tsconfig, as a repo file (null when external or missing). */
  private extendsFile(from: string, ext: string): string | null {
    if (ext.startsWith("./") || ext.startsWith("../") || ext.startsWith("/")) {
      const p = joinPath(dirOf(from), ext);
      if (p === null) return null;
      if (this.files.has(p)) return p;
      if (this.files.has(`${p}.json`)) return `${p}.json`;
      if (this.files.has(`${p}/tsconfig.json`)) return `${p}/tsconfig.json`;
      return null;
    }
    // A workspace package (e.g. "@acme/tsconfig/base.json").
    const { name, subpath } = splitPackageSpecifier(ext);
    if (name === null) return null;
    for (const pkg of this.byName.get(name) ?? []) {
      const p = joinPath(pkg.dir, subpath === "." ? "tsconfig.json" : subpath);
      if (p === null) continue;
      if (this.files.has(p)) return p;
      if (this.files.has(`${p}.json`)) return `${p}.json`;
    }
    return null;
  }

  /** Compiler options with `extends` applied (paths/baseUrl keep the directory they came from). */
  private effectiveCompilerOptions(
    file: string,
    seen: Set<string> = new Set(),
  ): {
    baseUrl?: string;
    baseUrlDir?: string;
    paths?: Record<string, string[]>;
    pathsDir?: string;
    outDir?: string;
    rootDir?: string;
  } {
    if (seen.has(file)) return {};
    seen.add(file);
    const cfg = this.loadTsconfig(file);
    if (cfg === null) return {};
    let merged: ReturnType<Resolver["effectiveCompilerOptions"]> = {};
    const exts = cfg.extends === undefined ? [] : Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends];
    for (const ext of exts) {
      const target = this.extendsFile(file, ext);
      if (target !== null) merged = { ...merged, ...this.effectiveCompilerOptions(target, seen) };
    }
    const co = cfg.compilerOptions;
    if (co?.baseUrl !== undefined) {
      merged.baseUrl = co.baseUrl;
      merged.baseUrlDir = dirOf(file);
    }
    if (co?.paths !== undefined) {
      merged.paths = co.paths;
      merged.pathsDir = dirOf(file);
    }
    if (co?.outDir !== undefined) merged.outDir = co.outDir;
    if (co?.rootDir !== undefined) merged.rootDir = co.rootDir;
    return merged;
  }

  /** The tsconfig `paths` configurations that govern `from` (nearest directory with a tsconfig). */
  private pathsFor(from: string): PathsConfig[] {
    const dir = dirOf(from);
    const cached = this.pathsCache.get(dir);
    if (cached !== undefined) return cached;
    let configs: PathsConfig[] = [];
    for (const d of ancestors(from)) {
      const files = this.tsconfigDirs.get(d);
      if (files === undefined) continue;
      for (const f of files) {
        const o = this.effectiveCompilerOptions(f);
        const baseUrl =
          o.baseUrl !== undefined && o.baseUrlDir !== undefined
            ? joinPath(o.baseUrlDir, o.baseUrl)
            : null;
        if (o.paths === undefined && baseUrl === null) continue;
        configs.push({
          base: baseUrl ?? o.pathsDir ?? d,
          paths: o.paths ?? {},
          baseUrl,
        });
      }
      break;
    }
    configs = configs.filter(
      (c, i) => configs.findIndex((o) => JSON.stringify(o) === JSON.stringify(c)) === i,
    );
    this.pathsCache.set(dir, configs);
    return configs;
  }

  private resolveTsPaths(from: string, spec: string, exists: FileSet): string[] | null {
    for (const cfg of this.pathsFor(from)) {
      // Longest matching prefix wins (TypeScript's rule).
      let best: { key: string; star: string } | null = null;
      for (const key of Object.keys(cfg.paths)) {
        const star = key.indexOf("*");
        if (star === -1) {
          if (key === spec) {
            best = { key, star: "" };
            break;
          }
          continue;
        }
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (
          spec.length >= prefix.length + suffix.length &&
          spec.startsWith(prefix) &&
          spec.endsWith(suffix) &&
          (best === null || prefix.length > best.key.indexOf("*"))
        ) {
          best = { key, star: spec.slice(prefix.length, spec.length - suffix.length) };
        }
      }
      if (best !== null) {
        const star = best.star;
        for (const target of cfg.paths[best.key] ?? []) {
          const p = joinPath(cfg.base, target.split("*").join(star));
          if (p === null) continue;
          const hit = this.resolveFile(p, exists);
          if (hit !== null) return [hit];
        }
      }
      if (cfg.baseUrl !== null) {
        const p = joinPath(cfg.baseUrl, spec);
        if (p !== null) {
          const hit = this.resolveFile(p, exists);
          if (hit !== null) return [hit];
        }
      }
    }
    return null;
  }
}

/** `@scope/name/sub/path` → { name: "@scope/name", subpath: "./sub/path" }. */
export function splitPackageSpecifier(spec: string): { name: string | null; subpath: string } {
  const parts = spec.split("/");
  if (spec.startsWith("@")) {
    if (parts.length < 2 || parts[1] === "") return { name: null, subpath: "." };
    const rest = parts.slice(2).join("/");
    return { name: `${parts[0]}/${parts[1]}`, subpath: rest === "" ? "." : `./${rest}` };
  }
  const rest = parts.slice(1).join("/");
  return { name: parts[0] ?? null, subpath: rest === "" ? "." : `./${rest}` };
}
