/** Path classification: tests, configs, docs and the file types the TS/JS analyzer scans. */
import { baseName, dirOf } from "./paths.js";

const IGNORED = /(^|\/)(node_modules|\.git)\//;

const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const COMPONENT_EXT = /\.(?:vue|svelte|astro|mdx)$/;
const MARKUP_EXT = /\.(?:html|htm)$/;
const STYLE_EXT = /\.(?:css|scss|sass|less)$/;

/** JS/TS module source (including declaration files). */
export function isCodeFile(path: string): boolean {
  return CODE_EXT.test(path) && !IGNORED.test(path);
}

/** Files the TS/JS analyzer scans for references (code, components, HTML, stylesheets). */
export function isScannedFile(path: string): boolean {
  if (IGNORED.test(path)) return false;
  return (
    CODE_EXT.test(path) || COMPONENT_EXT.test(path) || MARKUP_EXT.test(path) || STYLE_EXT.test(path)
  );
}

export function isMarkupFile(path: string): boolean {
  return MARKUP_EXT.test(path);
}

export function isStyleFile(path: string): boolean {
  return STYLE_EXT.test(path);
}

const TEST_NAME = /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TESTS_DIR = /(^|\/)__tests__\//;

/** vitest/jest default test file patterns. */
export function isTestFile(path: string): boolean {
  if (IGNORED.test(path)) return false;
  if (TEST_NAME.test(path)) return true;
  return TESTS_DIR.test(path) && CODE_EXT.test(path) && !path.endsWith(".d.ts");
}

const TEST_SUPPORT_DIR = /(^|\/)(test|tests|__tests__|__mocks__|__fixtures__|spec|fixtures)\//;

/** Tests and files under test-support directories (helpers, fixtures, mocks). */
export function isTestSupportFile(path: string): boolean {
  return isTestFile(path) || TEST_SUPPORT_DIR.test(path);
}

const CONFIG_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "biome.json",
  "biome.jsonc",
  ".browserslistrc",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
  ".dockerignore",
]);

const CONFIG_PATTERNS = [
  /^(?:ts|js)config(?:\..+)?\.json$/,
  /^(?:vitest|vite|jest|babel|eslint|prettier|playwright|stryker|rollup|webpack|esbuild|tsup)\.(?:config|workspace|projects)(?:\.[\w-]+)*\.(?:[cm]?[jt]s|json|jsonc|ya?ml)$/,
  /^\.(?:babelrc|eslintrc|prettierrc|swcrc)(?:\.\w+)?$/,
  /^Dockerfile(?:\..+)?$/,
  /\.dockerignore$/,
];

/**
 * Configuration that can change how anything builds, resolves or tests: manifests, lockfiles,
 * tsconfig, test-runner/bundler/lint configs, wrangler configs, Dockerfiles, `.platform/**`.
 */
export function isConfigFile(path: string): boolean {
  if (IGNORED.test(path)) return false;
  if (path.startsWith(".platform/")) return true;
  const base = baseName(path);
  if (CONFIG_BASENAMES.has(base)) return true;
  return CONFIG_PATTERNS.some((re) => re.test(base));
}

const RUNNER_CONFIG =
  /^(?:vitest|vite|jest|playwright)\.(?:config|workspace|projects)(?:\.[\w-]+)*\.[cm]?[jt]s$/;

/** Test-runner configs: files they reference (setupFiles, globalSetup) affect every test below them. */
export function isTestRunnerConfig(path: string): boolean {
  return RUNNER_CONFIG.test(baseName(path)) && !IGNORED.test(path);
}

const DOC_EXT = /\.(?:md|markdown|rst|adoc)$/i;
const DOC_NAME =
  /^(?:LICEN[CS]E|COPYING|AUTHORS|CHANGELOG|NOTICE|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)(?:\.\w+)?$/i;
const DOC_DIR = /(^|\/)docs\//;

/** Documentation nothing executes (outside test-support and fixture directories). */
export function isDocFile(path: string): boolean {
  if (IGNORED.test(path) || TEST_SUPPORT_DIR.test(path)) return false;
  const base = baseName(path);
  return DOC_EXT.test(base) || DOC_NAME.test(base) || DOC_DIR.test(path);
}

const META_BASENAMES = new Set([
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".editorconfig",
  ".mailmap",
  "CODEOWNERS",
  ".DS_Store",
]);
const META_DIR = /^(?:\.github|\.vscode|\.idea|\.devcontainer|\.claude|\.cursor)\//;

/** Repository metadata with no runtime or test effect. */
export function isMetaFile(path: string): boolean {
  return META_BASENAMES.has(baseName(path)) || META_DIR.test(path);
}

/** `x/__snapshots__/foo.test.ts.snap` → `x/foo.test.ts`. */
export function snapshotOwner(path: string): string | null {
  const m = /^(?:(.*)\/)?__snapshots__\/(.+)\.snap$/.exec(path);
  if (m === null || m[2] === undefined) return null;
  return m[1] === undefined ? m[2] : `${m[1]}/${m[2]}`;
}

/** Directory a config file governs ("" for repo-root configs). */
export function configScope(path: string): string {
  return path.startsWith(".platform/") ? "" : dirOf(path);
}
