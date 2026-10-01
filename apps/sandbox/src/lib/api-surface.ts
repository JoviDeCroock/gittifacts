/**
 * Public API surface extraction with the TypeScript compiler API.
 *
 * For a package entry point: compile the package with its tsconfig, emitting declarations only
 * and in memory; load the entry's emitted `.d.ts` in a second program (virtual files overlaid on
 * the real file system, so `node_modules` types still resolve); walk `getExportsOfModule`
 * (re-exports followed through aliases) and describe each export with the checker using stable
 * flags. The result is an `ExportSurface` (name → normalized signature text) for `diffApiSurface`.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { ExportSurface } from "@app/evidence";
import type * as TS from "typescript";
import { lazyTs as ts } from "./typescript.js";
import { z } from "zod";

// ---------------------------------------------------------------- discovery

export interface PackageEntry {
  /** package.json `name` (or its directory when unnamed). */
  name: string;
  /** Repo-relative directory of the package ("" for the root). */
  dir: string;
  /** Export subpath, e.g. "." or "./node". */
  entry: string;
  /** Repo-relative file the surface is extracted from (a source file or a checked-in .d.ts). */
  source: string;
}

export interface Discovery {
  entries: PackageEntry[];
  /** Entries we could not map to a source file (reported, never silently dropped). */
  problems: string[];
}

const Manifest = z
  .object({
    name: z.string().optional(),
    types: z.string().optional(),
    typings: z.string().optional(),
    exports: z.unknown().optional(),
    private: z.boolean().optional(),
  })
  .passthrough();

const TsConfigPaths = z
  .object({
    compilerOptions: z.object({ outDir: z.string().optional(), rootDir: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

function pickTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = pickTarget(v);
      if (t !== null) return t;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const cond of ["types", "import", "node", "default", "require"]) {
    if (cond in record) {
      const t = pickTarget(record[cond]);
      if (t !== null) return t;
    }
  }
  return null;
}

/** Subpath → declared target, from `exports` (or `types`). */
export function declaredEntries(manifest: z.infer<typeof Manifest>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const exp = manifest.exports;
  if (exp !== undefined && exp !== null) {
    if (typeof exp === "string" || Array.isArray(exp)) {
      const t = pickTarget(exp);
      if (t !== null) out.push([".", t]);
    } else if (typeof exp === "object") {
      const record = exp as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length > 0 && keys.every((k) => k.startsWith("."))) {
        for (const k of keys) {
          if (k.endsWith("/package.json") || k === "./package.json") continue;
          const t = pickTarget(record[k]);
          if (t !== null) out.push([k, t]);
        }
      } else {
        const t = pickTarget(exp);
        if (t !== null) out.push([".", t]);
      }
    }
  }
  const types = manifest.types ?? manifest.typings;
  if (types !== undefined && !out.some(([k]) => k === ".")) out.push([".", types]);
  return out;
}

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts"];

function stripDot(p: string): string {
  let out = p.replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out.replace(/\/+$/, "");
}

/**
 * Map a declared entry target (e.g. `./dist/index.d.ts`, `./dist/index.js`, `./src/index.ts`)
 * to a file in the tree: the source it is built from, or a checked-in declaration file.
 */
export function mapToSource(
  target: string,
  pkgDir: string,
  exists: (repoPath: string) => boolean,
  tsPaths: { outDir?: string | undefined; rootDir?: string | undefined },
): string | null {
  const t = stripDot(target);
  const inPkg = (p: string) => (pkgDir === "" ? p : `${pkgDir}/${p}`);
  if (SOURCE_EXTS.some((e) => t.endsWith(e)) && !/\.d\.[cm]?ts$/.test(t)) return exists(inPkg(t)) ? inPkg(t) : null;
  const stem = t.replace(/\.d\.([cm]?)ts$/, "").replace(/\.([cm]?)js$/, "");
  const outDir = tsPaths.outDir === undefined ? null : stripDot(tsPaths.outDir);
  const rootDir = tsPaths.rootDir === undefined ? null : stripDot(tsPaths.rootDir);
  const stems: string[] = [];
  if (outDir !== null && (stem === outDir || stem.startsWith(`${outDir}/`))) {
    const rest = stem.slice(outDir.length).replace(/^\//, "");
    if (rootDir !== null) stems.push(rootDir === "" || rootDir === "." ? rest : `${rootDir}/${rest}`);
    stems.push(`src/${rest}`, rest);
  }
  // Conventional layouts when tsconfig doesn't say.
  const m = /^(dist|build|lib|out|types)\/(.*)$/.exec(stem);
  if (m?.[2] !== undefined) stems.push(`src/${m[2]}`, m[2]);
  stems.push(stem);
  for (const s of stems) {
    for (const ext of SOURCE_EXTS) {
      if (exists(inPkg(`${s}${ext}`))) return inPkg(`${s}${ext}`);
    }
  }
  // A hand-written declaration file checked into the tree.
  if (/\.d\.[cm]?ts$/.test(t) && exists(inPkg(t))) return inPkg(t);
  return null;
}

export interface TreeReader {
  exists(path: string): boolean;
  read(path: string): string | null;
}

/** Find TypeScript package entry points in a tree (any commit, read through `reader`). */
export function discoverEntries(manifestPaths: readonly string[], reader: TreeReader): Discovery {
  const entries: PackageEntry[] = [];
  const problems: string[] = [];
  for (const mp of manifestPaths) {
    const pkgDir = mp === "package.json" ? "" : mp.slice(0, -"/package.json".length);
    const text = reader.read(mp);
    if (text === null) continue;
    let manifest: z.infer<typeof Manifest>;
    try {
      const parsed = Manifest.safeParse(JSON.parse(text));
      if (!parsed.success) continue;
      manifest = parsed.data;
    } catch {
      problems.push(`${mp}: invalid JSON`);
      continue;
    }
    const name = manifest.name ?? (pkgDir === "" ? "(root)" : pkgDir);
    const inPkg = (p: string) => (pkgDir === "" ? p : `${pkgDir}/${p}`);
    let tsPaths: { outDir?: string; rootDir?: string } = {};
    const tsconfigText = reader.read(inPkg("tsconfig.json"));
    if (tsconfigText !== null) {
      try {
        const parsed = ts.parseConfigFileTextToJson(inPkg("tsconfig.json"), tsconfigText);
        const paths = TsConfigPaths.safeParse(parsed.config);
        if (paths.success) {
          const co = paths.data.compilerOptions;
          tsPaths = {
            ...(co?.outDir === undefined ? {} : { outDir: co.outDir }),
            ...(co?.rootDir === undefined ? {} : { rootDir: co.rootDir }),
          };
        }
      } catch {
        // Fall back to conventions.
      }
    }
    const declared = declaredEntries(manifest);
    const seen = new Set<string>();
    for (const [subpath, target] of declared) {
      if (subpath.includes("*") || target.includes("*")) {
        problems.push(`${name}: wildcard export ${subpath} is not analysed`);
        continue;
      }
      if (!/\.(d\.[cm]?ts|[cm]?[jt]sx?)$/.test(target)) continue; // css, json, ...
      const source = mapToSource(target, pkgDir, (p) => reader.exists(p), tsPaths);
      if (source === null) {
        problems.push(`${name}: cannot map export ${subpath} (${target}) to a TypeScript source`);
        continue;
      }
      if (seen.has(subpath)) continue;
      seen.add(subpath);
      entries.push({ name, dir: pkgDir, entry: subpath, source });
    }
    if (declared.length === 0 && reader.exists(inPkg("src/index.ts"))) {
      entries.push({ name, dir: pkgDir, entry: ".", source: inPkg("src/index.ts") });
    }
  }
  return { entries, problems };
}

// ---------------------------------------------------------------- compile + extract

let typeFlags: number | undefined;
/** Stable, untruncated type printing (computed lazily: TypeScript loads on first use). */
function flags(): TS.TypeFormatFlags {
  typeFlags ??=
    ts.TypeFormatFlags.NoTruncation |
    ts.TypeFormatFlags.WriteArrayAsGenericType |
    ts.TypeFormatFlags.UseStructuralFallback |
    ts.TypeFormatFlags.AllowUniqueESSymbolType |
    ts.TypeFormatFlags.WriteTypeArgumentsOfSignature;
  return typeFlags;
}

export interface SurfaceResult {
  surface: ExportSurface | null;
  error?: string;
  /** Type errors in the package's program (the surface may be imprecise). */
  typeErrors: number;
}

const toPosix = (p: string) => p.split(sep).join(posix.sep);

function formatDiagnostic(d: TS.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(d.messageText, "\n");
}

interface Compiled {
  options: TS.CompilerOptions;
  rootNames: string[];
  virtual: Map<string, string>;
  typeErrors: number;
  configError?: string;
}

function compilePackage(pkgAbs: string, extraRoots: readonly string[]): Compiled {
  const configPath = join(pkgAbs, "tsconfig.json");
  let options: TS.CompilerOptions;
  let fileNames: string[];
  if (existsSync(configPath)) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) {
      return { options: {}, rootNames: [], virtual: new Map(), typeErrors: 0, configError: formatDiagnostic(read.error) };
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, pkgAbs, undefined, configPath);
    options = parsed.options;
    fileNames = parsed.fileNames;
  } else {
    options = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
    };
    fileNames = [];
  }
  const emitOptions: TS.CompilerOptions = {
    ...options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    inlineSourceMap: false,
    inlineSources: false,
    composite: false,
    incremental: false,
    noEmitOnError: false,
    skipLibCheck: true,
  };
  delete emitOptions.tsBuildInfoFile;
  delete emitOptions.declarationDir;
  delete emitOptions.outFile;
  const rootNames = [...new Set([...fileNames, ...extraRoots])];
  const host = ts.createCompilerHost(emitOptions, true);
  const program = ts.createProgram({ rootNames, options: emitOptions, host });
  const virtual = new Map<string, string>();
  program.emit(
    undefined,
    (fileName, text) => {
      virtual.set(resolve(fileName), text);
    },
    undefined,
    true,
  );
  const typeErrors = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error).length;
  return { options: emitOptions, rootNames, virtual, typeErrors };
}

function declarationFor(compiled: Compiled, sourceAbs: string): string | null {
  if (/\.d\.[cm]?ts$/.test(sourceAbs)) return sourceAbs;
  const commandLine: TS.ParsedCommandLine = { options: compiled.options, fileNames: compiled.rootNames, errors: [] };
  const outputs = ts.getOutputFileNames(commandLine, sourceAbs, !ts.sys.useCaseSensitiveFileNames);
  const dts = outputs.find((o) => /\.d\.[cm]?ts$/.test(o));
  return dts === undefined ? null : resolve(dts);
}

function overlayHost(options: TS.CompilerOptions, virtual: ReadonlyMap<string, string>): TS.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const dirs = new Set<string>();
  for (const file of virtual.keys()) {
    let d = dirname(file);
    while (!dirs.has(d)) {
      dirs.add(d);
      const parent = dirname(d);
      if (parent === d) break;
      d = parent;
    }
  }
  const original = { ...host };
  host.fileExists = (f) => virtual.has(resolve(f)) || original.fileExists(f);
  host.readFile = (f) => virtual.get(resolve(f)) ?? original.readFile(f);
  host.directoryExists = (d) => dirs.has(resolve(d)) || (original.directoryExists?.(d) ?? ts.sys.directoryExists(d));
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = virtual.get(resolve(fileName));
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return original.getSourceFile(fileName, languageVersion, onError, shouldCreate);
  };
  return host;
}

function typeParams(decls: readonly TS.Declaration[] | undefined): string {
  for (const d of decls ?? []) {
    const tps = (d as { typeParameters?: TS.NodeArray<TS.TypeParameterDeclaration> }).typeParameters;
    if (tps && tps.length > 0) return `<${tps.map((tp) => tp.getText().replace(/\s+/g, " ")).join(", ")}>`;
  }
  return "";
}

function isPrivateMember(symbol: TS.Symbol): boolean {
  return (symbol.declarations ?? []).some((d) => {
    if ((ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Private) !== 0) return true;
    const name = (d as { name?: TS.Node }).name;
    return name !== undefined && ts.isPrivateIdentifier(name);
  });
}

function memberLine(checker: TS.TypeChecker, prop: TS.Symbol, at: TS.Node): string {
  const decl = prop.valueDeclaration ?? prop.declarations?.[0];
  const modifiers = decl ? ts.getCombinedModifierFlags(decl) : 0;
  const mods = [
    modifiers & ts.ModifierFlags.Protected ? "protected " : "",
    modifiers & ts.ModifierFlags.Readonly ? "readonly " : "",
  ].join("");
  const optional = prop.flags & ts.SymbolFlags.Optional ? "?" : "";
  const type = checker.typeToString(checker.getTypeOfSymbolAtLocation(prop, decl ?? at), undefined, flags());
  return `${mods}${prop.getName()}${optional}: ${type}`;
}

function signaturesOf(checker: TS.TypeChecker, type: TS.Type, kind: TS.SignatureKind, prefix: string): string[] {
  return checker
    .getSignaturesOfType(type, kind)
    .map((s) => `${prefix}${checker.signatureToString(s, undefined, flags(), kind === ts.SignatureKind.Construct ? ts.SignatureKind.Construct : ts.SignatureKind.Call)}`);
}

function indexInfos(checker: TS.TypeChecker, type: TS.Type): string[] {
  return checker.getIndexInfosOfType(type).map((info) => {
    const key = checker.typeToString(info.keyType, undefined, flags());
    const value = checker.typeToString(info.type, undefined, flags());
    return `${info.isReadonly ? "readonly " : ""}[key: ${key}]: ${value}`;
  });
}

/** Normalized description of one exported symbol (already de-aliased). */
export function describeSymbol(checker: TS.TypeChecker, symbol: TS.Symbol, at: TS.Node, depth = 0): string {
  const parts: string[] = [];
  const f = symbol.flags;
  const decls = symbol.declarations ?? [];
  if (f & ts.SymbolFlags.Function) {
    const type = checker.getTypeOfSymbolAtLocation(symbol, at);
    parts.push(...signaturesOf(checker, type, ts.SignatureKind.Call, "function "));
  }
  if (f & ts.SymbolFlags.Class) {
    const instance = checker.getDeclaredTypeOfSymbol(symbol);
    const ctor = checker.getTypeOfSymbolAtLocation(symbol, at);
    const abstract = decls.some((d) => ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Abstract) ? "abstract " : "";
    const bases = checker.getBaseTypes(instance as TS.InterfaceType).map((b) => checker.typeToString(b, undefined, flags()));
    const members = checker
      .getPropertiesOfType(instance)
      .filter((p) => !isPrivateMember(p))
      .map((p) => memberLine(checker, p, at))
      .sort();
    const statics = checker
      .getPropertiesOfType(ctor)
      .filter((p) => p.getName() !== "prototype" && !isPrivateMember(p))
      .map((p) => `static ${memberLine(checker, p, at)}`)
      .sort();
    parts.push(
      [
        `${abstract}class${typeParams(decls)}${bases.length > 0 ? ` extends ${bases.join(", ")}` : ""} {`,
        ...signaturesOf(checker, ctor, ts.SignatureKind.Construct, "  "),
        ...statics.map((s) => `  ${s}`),
        ...members.map((m) => `  ${m}`),
        "}",
      ].join("\n"),
    );
  }
  if (f & ts.SymbolFlags.Interface) {
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const bases = checker.getBaseTypes(type as TS.InterfaceType).map((b) => checker.typeToString(b, undefined, flags()));
    const members = checker
      .getPropertiesOfType(type)
      .map((p) => memberLine(checker, p, at))
      .sort();
    parts.push(
      [
        `interface${typeParams(decls)}${bases.length > 0 ? ` extends ${bases.join(", ")}` : ""} {`,
        ...signaturesOf(checker, type, ts.SignatureKind.Call, "  "),
        ...signaturesOf(checker, type, ts.SignatureKind.Construct, "  "),
        ...indexInfos(checker, type).map((i) => `  ${i}`),
        ...members.map((m) => `  ${m}`),
        "}",
      ].join("\n"),
    );
  }
  if (f & ts.SymbolFlags.TypeAlias) {
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    parts.push(`type${typeParams(decls)} = ${checker.typeToString(type, undefined, flags() | ts.TypeFormatFlags.InTypeAlias)}`);
  }
  if (f & ts.SymbolFlags.Enum) {
    const members = checker
      .getExportsOfModule(symbol)
      .map((m) => {
        const d = m.valueDeclaration;
        const value = d && ts.isEnumMember(d) ? checker.getConstantValue(d) : undefined;
        return `${m.getName()} = ${value === undefined ? "?" : JSON.stringify(value)}`;
      });
    parts.push(`${f & ts.SymbolFlags.ConstEnum ? "const " : ""}enum { ${members.join(", ")} }`);
  }
  if (f & ts.SymbolFlags.Variable) {
    const decl = symbol.valueDeclaration;
    const keyword =
      decl && ts.isVariableDeclaration(decl) && decl.parent && ts.isVariableDeclarationList(decl.parent)
        ? decl.parent.flags & ts.NodeFlags.Const
          ? "const"
          : "let"
        : "var";
    parts.push(`${keyword}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, at), undefined, flags())}`);
  }
  if (f & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule) && depth < 4) {
    const exports = checker.getExportsOfModule(symbol);
    const inner = exports
      .map((e) => {
        const t = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
        return `  ${e.getName()}: ${describeSymbol(checker, t, at, depth + 1).replace(/\n/g, "\n  ")}`;
      })
      .sort();
    parts.push(["namespace {", ...inner, "}"].join("\n"));
  }
  if (parts.length === 0) parts.push(`unknown symbol kind ${f}`);
  return parts.join("\n");
}

/** Exported names of `dtsAbs` → description. */
export function surfaceOfDeclarationFile(dtsAbs: string, options: TS.CompilerOptions, virtual: ReadonlyMap<string, string>): ExportSurface {
  const readOptions: TS.CompilerOptions = { ...options, noEmit: true, emitDeclarationOnly: false, declaration: false, types: options.types ?? [] };
  const host = overlayHost(readOptions, virtual);
  const program = ts.createProgram({ rootNames: [dtsAbs], options: readOptions, host });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(dtsAbs);
  if (source === undefined) throw new Error(`declaration file ${dtsAbs} was not loaded`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const surface: Record<string, string> = {};
  if (moduleSymbol === undefined) return surface; // not a module: exports nothing
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    surface[exported.getName()] = describeSymbol(checker, target, source);
  }
  return surface;
}

/**
 * Surfaces of `entries` (all in one package dir) in a checkout at `rootAbs`. One compile per
 * package; errors are per entry.
 */
export function extractPackageSurfaces(rootAbs: string, entries: readonly PackageEntry[]): Map<string, SurfaceResult> {
  const out = new Map<string, SurfaceResult>();
  if (entries.length === 0) return out;
  const pkgAbs = resolve(rootAbs, entries[0]?.dir ?? "");
  const sources = entries.map((e) => resolve(rootAbs, e.source)).filter((s) => !/\.d\.[cm]?ts$/.test(s));
  let compiled: Compiled;
  try {
    compiled = compilePackage(pkgAbs, sources);
  } catch (error) {
    for (const e of entries) out.set(e.entry, { surface: null, error: `compiling ${e.name} failed: ${String(error)}`, typeErrors: 0 });
    return out;
  }
  if (compiled.configError !== undefined) {
    for (const e of entries) out.set(e.entry, { surface: null, error: `tsconfig: ${compiled.configError}`, typeErrors: 0 });
    return out;
  }
  for (const e of entries) {
    const sourceAbs = resolve(rootAbs, e.source);
    const dts = declarationFor(compiled, sourceAbs);
    if (dts === null || !(compiled.virtual.has(dts) || (isAbsolute(dts) && existsSync(dts) && /\.d\.[cm]?ts$/.test(sourceAbs)))) {
      out.set(e.entry, {
        surface: null,
        error: `no declaration was emitted for ${e.source}${dts === null ? "" : ` (expected ${toPosix(relative(rootAbs, dts))})`}`,
        typeErrors: compiled.typeErrors,
      });
      continue;
    }
    try {
      out.set(e.entry, { surface: surfaceOfDeclarationFile(dts, compiled.options, compiled.virtual), typeErrors: compiled.typeErrors });
    } catch (error) {
      out.set(e.entry, { surface: null, error: `reading ${e.source}'s declarations failed: ${String(error)}`, typeErrors: compiled.typeErrors });
    }
  }
  return out;
}
