/**
 * Evaluating repository configuration modules (`.platform/policy.ts`, `.platform/ci.ts`).
 *
 * The file is bundled with esbuild (TypeScript stripped, relative imports inlined) into one ESM
 * file and imported in a CHILD node process with a hard timeout, so a hostile or broken module
 * can neither hang nor crash the runner. Helper imports (`definePolicy`, `definePipeline` from
 * the platform packages) resolve to tiny shims; other bare imports are bundled from the
 * checkout's node_modules when present.
 *
 * Files can be read from the working tree or from a git commit (the policy is always read from
 * BASE, never from the working tree, which is head).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "esbuild";
import { readBlob } from "./git.js";
import { errorMessage } from "./log.js";
import { run } from "./proc.js";

/** Packages whose helpers `.platform/*.ts` files may import. */
export const SHIMMED_MODULES = [
  "gittifacts",
  "gittifacts/ci",
  "gittifacts/policy",
  "@gittifacts/ci",
  "@gittifacts/policy",
  "@gittifacts/config",
  "@app/ci-engine",
  "@app/ci-engine/plan",
  "@app/domain",
];

const SHIM_SOURCE = `
export const definePipeline = (fn) => fn;
export const definePolicy = (value) => value;
export default { definePipeline, definePolicy };
`;

export type ModuleSource = { kind: "fs"; path: string } | { kind: "git"; repo: string; rev: string; path: string };

export type BundleResult = { ok: true; file: string } | { ok: false; error: string };

function gitPlugin(repo: string, rev: string): Plugin {
  return {
    name: "git-tree",
    setup(build) {
      build.onResolve({ filter: /^\./ }, (args) => {
        if (args.namespace !== "git") return undefined;
        const joined = posix.normalize(posix.join(posix.dirname(args.importer), args.path));
        return { path: joined, namespace: "git" };
      });
      build.onLoad({ filter: /.*/, namespace: "git" }, async (args) => {
        const candidates = [args.path, ...[".ts", ".mts", ".js", ".mjs", "/index.ts", "/index.js"].map((e) => `${args.path}${e}`)];
        if (/\.(m?js)$/.test(args.path)) candidates.push(args.path.replace(/\.(m?)js$/, ".$1ts"));
        for (const c of candidates) {
          const text = await readBlob(repo, rev, c);
          if (text !== null) {
            const loader = /\.m?ts$|\.cts$/.test(c) ? "ts" : /\.json$/.test(c) ? "json" : "js";
            return { contents: text, loader, resolveDir: undefined };
          }
        }
        return { errors: [{ text: `${args.path} does not exist at ${rev.slice(0, 12)}` }] };
      });
    },
  };
}

const shimPlugin: Plugin = {
  name: "platform-shims",
  setup(build) {
    const filter = new RegExp(`^(${SHIMMED_MODULES.map((m) => m.replace(/[/@.]/g, "\\$&")).join("|")})$`);
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "shim" }));
    build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({ contents: SHIM_SOURCE, loader: "js" }));
  },
};

/** Bundle `source` into `<outDir>/module.mjs`. */
export async function bundleModule(source: ModuleSource, outDir: string): Promise<BundleResult> {
  let esbuild: typeof import("esbuild");
  try {
    esbuild = await import("esbuild");
  } catch (error) {
    return { ok: false, error: `esbuild is not available: ${errorMessage(error)}` };
  }
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, "module.mjs");
  try {
    const plugins: Plugin[] = [shimPlugin];
    let entryPoints: string[];
    if (source.kind === "git") {
      plugins.push(gitPlugin(source.repo, source.rev));
      plugins.unshift({
        name: "git-entry",
        setup(build) {
          build.onResolve({ filter: /^gittifacts-entry:/ }, (args) => ({ path: args.path.slice("gittifacts-entry:".length), namespace: "git" }));
        },
      });
      entryPoints = [`gittifacts-entry:${source.path}`];
    } else {
      entryPoints = [source.path];
    }
    const result = await esbuild.build({
      entryPoints,
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      write: false,
      logLevel: "silent",
      plugins,
      absWorkingDir: source.kind === "fs" ? dirname(source.path) : outDir,
    });
    const out = result.outputFiles?.[0];
    if (out === undefined) return { ok: false, error: "esbuild produced no output" };
    writeFileSync(outfile, out.contents);
    return { ok: true, file: outfile };
  } catch (error) {
    const failure = error as { errors?: Array<{ text: string; location?: { file: string; line: number } | null }> };
    if (Array.isArray(failure.errors) && failure.errors.length > 0) {
      return {
        ok: false,
        error: failure.errors
          .slice(0, 5)
          .map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text))
          .join("; "),
      };
    }
    return { ok: false, error: errorMessage(error) };
  }
}

export type EvalResult = { ok: true; value: unknown } | { ok: false; error: string };

const RESULT_PREFIX = "::gittifacts-eval::";

/** Import `file` in a child process and return its JSON-serialized default export. */
export async function evaluateDefaultExport(file: string, cwd: string, timeoutMs = 15_000): Promise<EvalResult> {
  const script = [
    `const mod = await import(${JSON.stringify(pathToFileURL(file).href)});`,
    "const value = mod.default;",
    `process.stdout.write("\\n${RESULT_PREFIX}" + JSON.stringify(value === undefined ? null : value) + "\\n");`,
  ].join("\n");
  const r = await run(process.execPath, ["--input-type=module", "-e", script], { cwd, timeoutMs, echo: false, env: { NODE_OPTIONS: undefined } });
  if (r.timedOut) return { ok: false, error: `evaluating the module did not finish within ${timeoutMs} ms` };
  const line = r.stdout.split("\n").find((l) => l.startsWith(RESULT_PREFIX));
  if (r.code !== 0 || line === undefined) {
    return { ok: false, error: `evaluating the module failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-1500)}` };
  }
  try {
    return { ok: true, value: JSON.parse(line.slice(RESULT_PREFIX.length)) };
  } catch (error) {
    return { ok: false, error: `the default export is not JSON-serializable: ${errorMessage(error)}` };
  }
}

/** Write a file (helper for callers staging inputs). */
export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
