/**
 * Fixture repositories: loading `fixtures/<name>/fixture.json` and materializing a
 * fixture into a real git repository with a deterministic base and head commit.
 *
 * Layout (see fixtures/README.md):
 *   fixtures/_base/              the shared starting tree
 *   fixtures/<name>/fixture.json claim, plan and expectations
 *   fixtures/<name>/base/        optional overlay applied to _base to form this fixture's base
 *   fixtures/<name>/head/        overlay applied on top of the base to form the head
 *   fixtures/<name>/deleted.txt  optional list of paths deleted at head
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { devNull } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURES_DIR = join(REPO_ROOT, "fixtures");
export const BASE_TREE_DIR = join(FIXTURES_DIR, "_base");
/** Default parent directory for materialized repos (gitignored). */
export const DEFAULT_OUT_DIR = join(FIXTURES_DIR, ".materialized");

// ---------------------------------------------------------------- fixture spec

export type Lane = 0 | 1 | 2;
export type RedGreenVerdict = "proven" | "not-proven" | "no-tests";
export type ApiClassification = "none" | "additive" | "breaking";

export const CLAIM_CATEGORIES = [
  "fix",
  "feature",
  "refactor",
  "dependency",
  "transform",
  "revert",
  "docs",
  "chore",
] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];

export interface FixtureClaim {
  category: ClaimCategory;
  title: string;
}

export interface FixtureRiskDeclaration {
  area: string;
  description: string;
}

/** The approved Plan the change is judged against (mirrors `PlanDraftInput` + approval). */
export interface FixturePlan {
  title: string;
  intent: string;
  acceptanceCriteria: string[];
  outOfScope: string[];
  riskDeclarations: FixtureRiskDeclaration[];
  scopePaths: string[];
  affectedRoutes: string[];
  approved: boolean;
}

/** A reproducible transform the change claims to be the output of. */
export interface FixtureTransform {
  /** Repo-relative path of the transform script, under `.platform/transforms/`. */
  script: string;
  /** Shell command run from the repository root. */
  command: string;
  /** Which commit the script is taken from when re-running it on the base tree. */
  source: "base" | "head";
}

/** Key facts the evidence pipeline must report. Every field is optional. */
export interface ExpectedEvidence {
  /** Repo-relative paths changed between base and head, sorted. */
  changedFiles?: string[];
  redGreen?: RedGreenVerdict;
  /** `<file> > <describe…> > <test>` of new/changed tests that fail on base. */
  failingOnBase?: string[];
  publicApi?: ApiClassification;
  apiAdded?: string[];
  apiChanged?: string[];
  apiRemoved?: string[];
  dependenciesAdded?: string[];
  dependenciesRemoved?: string[];
  lockfileChanged?: boolean;
  /** Changed paths that match the base policy's `sensitivePaths`. */
  sensitiveHits?: string[];
  /** Changed paths outside the plan's `scopePaths`. */
  scopeDrift?: string[];
  policyChanged?: boolean;
  transformVerified?: boolean;
}

export interface FixtureExpectation {
  /** Lane before shadow mode (the classifier's max over reasons). */
  computedLane: Lane;
  /** Lane the change is routed to under the fixture's base policy (lane0Enabled: false). */
  laneWithShadow: Lane;
  /** A human other than the author must approve (e.g. anything under .platform/ changed). */
  requiresHumanApproval: boolean;
  /** Codes from the classifier's REASON_CODES that MUST appear (others may appear too). */
  reasonCodes: string[];
  evidence: ExpectedEvidence;
}

export interface Fixture {
  name: string;
  description: string;
  claim: FixtureClaim;
  transform?: FixtureTransform;
  plan: FixturePlan;
  expected: FixtureExpectation;
}

class FixtureSpecError extends Error {
  constructor(file: string, path: string, message: string) {
    super(`${file}: ${path || "<root>"} ${message}`);
    this.name = "FixtureSpecError";
  }
}

type Reader = {
  object(value: unknown, path: string): Record<string, unknown>;
  string(value: unknown, path: string, min?: number, max?: number): string;
  strings(value: unknown, path: string, min?: number, max?: number): string[];
  boolean(value: unknown, path: string): boolean;
  lane(value: unknown, path: string): Lane;
  oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T;
  keys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void;
};

function reader(file: string): Reader {
  const fail = (path: string, message: string): never => {
    throw new FixtureSpecError(file, path, message);
  };
  const self: Reader = {
    object(value, path) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return fail(path, "must be an object");
      }
      return value as Record<string, unknown>;
    },
    string(value, path, min = 0, max = Number.POSITIVE_INFINITY) {
      if (typeof value !== "string") return fail(path, "must be a string");
      if (value.length < min || value.length > max) {
        return fail(path, `must be ${min}..${max} characters long`);
      }
      return value;
    },
    strings(value, path, min = 0, max = Number.POSITIVE_INFINITY) {
      if (!Array.isArray(value)) return fail(path, "must be an array of strings");
      if (value.length < min || value.length > max) {
        return fail(path, `must have ${min}..${max} entries`);
      }
      return value.map((item, index) => self.string(item, `${path}[${index}]`, 1));
    },
    boolean(value, path) {
      if (typeof value !== "boolean") return fail(path, "must be a boolean");
      return value;
    },
    lane(value, path) {
      if (value !== 0 && value !== 1 && value !== 2) return fail(path, "must be 0, 1 or 2");
      return value;
    },
    oneOf(value, path, options) {
      if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
        return fail(path, `must be one of ${options.join(", ")}`);
      }
      return value as (typeof options)[number];
    },
    keys(value, path, allowed) {
      for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) fail(`${path}.${key}`, "is not a known field");
      }
    },
  };
  return self;
}

const EVIDENCE_STRING_LISTS = [
  "changedFiles",
  "failingOnBase",
  "apiAdded",
  "apiChanged",
  "apiRemoved",
  "dependenciesAdded",
  "dependenciesRemoved",
  "sensitiveHits",
  "scopeDrift",
] as const;
const EVIDENCE_BOOLEANS = ["lockfileChanged", "policyChanged", "transformVerified"] as const;

/** Validates a parsed fixture.json. Throws a descriptive error on the first problem. */
export function parseFixture(raw: unknown, file: string): Fixture {
  const r = reader(file);
  const root = r.object(raw, "");
  r.keys(root, "", ["name", "description", "claim", "transform", "plan", "expected"]);

  const claimRaw = r.object(root.claim, "claim");
  r.keys(claimRaw, "claim", ["category", "title"]);
  const claim: FixtureClaim = {
    category: r.oneOf(claimRaw.category, "claim.category", CLAIM_CATEGORIES),
    title: r.string(claimRaw.title, "claim.title", 1, 200),
  };

  let transform: FixtureTransform | undefined;
  if (root.transform !== undefined) {
    const t = r.object(root.transform, "transform");
    r.keys(t, "transform", ["script", "command", "source"]);
    transform = {
      script: r.string(t.script, "transform.script", 1),
      command: r.string(t.command, "transform.command", 1),
      source: r.oneOf(t.source, "transform.source", ["base", "head"] as const),
    };
    if (!transform.script.startsWith(".platform/transforms/")) {
      throw new FixtureSpecError(file, "transform.script", "must live under .platform/transforms/");
    }
  }

  // Bounds mirror the Plan schema in packages/domain/src/model.ts.
  const p = r.object(root.plan, "plan");
  r.keys(p, "plan", [
    "title",
    "intent",
    "acceptanceCriteria",
    "outOfScope",
    "riskDeclarations",
    "scopePaths",
    "affectedRoutes",
    "approved",
  ]);
  if (!Array.isArray(p.riskDeclarations)) {
    throw new FixtureSpecError(file, "plan.riskDeclarations", "must be an array");
  }
  const plan: FixturePlan = {
    title: r.string(p.title, "plan.title", 3, 200),
    intent: r.string(p.intent, "plan.intent", 10, 10_000),
    acceptanceCriteria: r.strings(p.acceptanceCriteria, "plan.acceptanceCriteria", 1, 50),
    outOfScope: r.strings(p.outOfScope, "plan.outOfScope", 0, 50),
    riskDeclarations: p.riskDeclarations.map((item: unknown, index) => {
      const path = `plan.riskDeclarations[${index}]`;
      const d = r.object(item, path);
      r.keys(d, path, ["area", "description"]);
      return {
        area: r.string(d.area, `${path}.area`, 1, 200),
        description: r.string(d.description, `${path}.description`, 1, 2000),
      };
    }),
    scopePaths: r.strings(p.scopePaths, "plan.scopePaths", 0, 100),
    affectedRoutes: r.strings(p.affectedRoutes, "plan.affectedRoutes", 0, 20),
    approved: r.boolean(p.approved, "plan.approved"),
  };

  const e = r.object(root.expected, "expected");
  r.keys(e, "expected", [
    "computedLane",
    "laneWithShadow",
    "requiresHumanApproval",
    "reasonCodes",
    "evidence",
  ]);
  const ev = r.object(e.evidence, "expected.evidence");
  r.keys(ev, "expected.evidence", [
    ...EVIDENCE_STRING_LISTS,
    ...EVIDENCE_BOOLEANS,
    "redGreen",
    "publicApi",
  ]);
  const evidence: ExpectedEvidence = {};
  for (const key of EVIDENCE_STRING_LISTS) {
    if (ev[key] !== undefined) evidence[key] = r.strings(ev[key], `expected.evidence.${key}`);
  }
  for (const key of EVIDENCE_BOOLEANS) {
    if (ev[key] !== undefined) evidence[key] = r.boolean(ev[key], `expected.evidence.${key}`);
  }
  if (ev.redGreen !== undefined) {
    evidence.redGreen = r.oneOf(ev.redGreen, "expected.evidence.redGreen", [
      "proven",
      "not-proven",
      "no-tests",
    ] as const);
  }
  if (ev.publicApi !== undefined) {
    evidence.publicApi = r.oneOf(ev.publicApi, "expected.evidence.publicApi", [
      "none",
      "additive",
      "breaking",
    ] as const);
  }
  const expected: FixtureExpectation = {
    computedLane: r.lane(e.computedLane, "expected.computedLane"),
    laneWithShadow: r.lane(e.laneWithShadow, "expected.laneWithShadow"),
    requiresHumanApproval: r.boolean(e.requiresHumanApproval, "expected.requiresHumanApproval"),
    reasonCodes: r.strings(e.reasonCodes, "expected.reasonCodes"),
    evidence,
  };
  if (expected.laneWithShadow < expected.computedLane) {
    throw new FixtureSpecError(file, "expected.laneWithShadow", "can never be below computedLane");
  }
  if (evidence.transformVerified !== undefined && transform === undefined) {
    throw new FixtureSpecError(file, "expected.evidence.transformVerified", "needs a transform");
  }

  const fixture: Fixture = {
    name: r.string(root.name, "name", 1),
    description: r.string(root.description, "description", 1),
    claim,
    plan,
    expected,
  };
  if (transform !== undefined) fixture.transform = transform;
  return fixture;
}

/** Names of all fixtures (directories under fixtures/ with a fixture.json), sorted. */
export function listFixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !/^[._]/.test(entry.name))
    .filter((entry) => existsSync(join(FIXTURES_DIR, entry.name, "fixture.json")))
    .map((entry) => entry.name)
    .sort();
}

export function loadFixture(name: string): Fixture {
  const file = join(FIXTURES_DIR, name, "fixture.json");
  if (!existsSync(file)) {
    throw new Error(`unknown fixture "${name}" (known: ${listFixtureNames().join(", ")})`);
  }
  const fixture = parseFixture(JSON.parse(readFileSync(file, "utf8")), relative(REPO_ROOT, file));
  if (fixture.name !== name) {
    throw new Error(`${file}: name "${fixture.name}" does not match its directory "${name}"`);
  }
  return fixture;
}

// ---------------------------------------------------------------- globs

/**
 * Minimal glob → RegExp for repo-relative POSIX paths: `**` spans directories,
 * `*` and `?` stay within one segment. Dotfiles match (like picomatch `{ dot: true }`).
 */
export function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char === "*") {
      const doubleStar = glob.charAt(i + 1) === "*";
      const segmentStart = i === 0 || glob.charAt(i - 1) === "/";
      if (doubleStar && segmentStart && glob.charAt(i + 2) === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else if (doubleStar && segmentStart && i + 2 === glob.length) {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
        if (doubleStar) i += 1;
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

// ---------------------------------------------------------------- git

export interface GitIdentity {
  name: string;
  email: string;
  /** ISO-8601 UTC timestamp, used for both author and committer dates. */
  date: string;
}

export const BASE_IDENTITY: GitIdentity = {
  name: "Fixture Maintainer",
  email: "maintainer@fixtures.gittifacts.invalid",
  date: "2026-01-01T09:00:00Z",
};
export const HEAD_IDENTITY: GitIdentity = {
  name: "Fixture Agent",
  email: "agent@fixtures.gittifacts.invalid",
  date: "2026-01-02T09:00:00Z",
};

/** Environment that isolates git from the user's config, hooks and signing. */
export function gitEnv(identity: GitIdentity = BASE_IDENTITY): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  const date = `@${Math.floor(Date.parse(identity.date) / 1000)} +0000`;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_COMMITTER_DATE: date,
    TZ: "UTC",
    LC_ALL: "C",
  };
}

const GIT_CONFIG = [
  "-c",
  "init.defaultBranch=main",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fileMode=true",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
];

/** Runs git in `cwd` with an isolated, deterministic environment and returns trimmed stdout. */
export async function git(
  cwd: string,
  args: readonly string[],
  identity: GitIdentity = BASE_IDENTITY,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...GIT_CONFIG, ...args], {
      cwd,
      env: gitEnv(identity),
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr.trim() || String(error)}`);
  }
}

// ---------------------------------------------------------------- materialize

const SKIPPED_NAMES = new Set([".DS_Store", "node_modules"]);

/** Repo-relative POSIX paths of every file under `dir`, sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (SKIPPED_NAMES.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join(posix.sep));
      else throw new Error(`unsupported file type in fixture tree: ${full}`);
    }
  };
  walk(dir);
  return out.sort();
}

/** Copies every file of `overlay` over `target`, normalizing modes to 0644/0755. */
export function applyOverlay(overlay: string, target: string): string[] {
  const files = listFiles(overlay);
  for (const file of files) {
    const from = join(overlay, file);
    const to = join(target, file);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    chmodSync(to, statSync(from).mode & 0o111 ? 0o755 : 0o644);
  }
  return files;
}

function readDeletions(name: string): string[] {
  const file = join(FIXTURES_DIR, name, "deleted.txt");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export interface MaterializeOptions {
  /**
   * Parent directory to create the repository in; the repo lands at `<outDir>/<name>`.
   * Defaults to `fixtures/.materialized`. An existing repo there is replaced.
   */
  outDir?: string;
}

export interface MaterializedFixture {
  /** Absolute path of the git repository (working tree checked out at head, branch `change`). */
  dir: string;
  /** Commit on `main`: `_base` plus the fixture's optional `base/` overlay. */
  baseSha: string;
  /** Commit on `change` (child of baseSha): base plus `head/` overlay minus `deleted.txt`. */
  headSha: string;
  fixture: Fixture;
}

export const BASE_COMMIT_MESSAGE = "Import @fixture/lib";

/**
 * Creates a fresh git repository for a fixture with two commits: the base on `main`
 * and the head on `change`. Author, committer and dates are fixed, so the SHAs are
 * stable across runs and machines.
 */
export async function materializeFixture(
  name: string,
  options: MaterializeOptions = {},
): Promise<MaterializedFixture> {
  const fixture = loadFixture(name);
  const dir = resolve(options.outDir ?? DEFAULT_OUT_DIR, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  await git(dir, ["init", "-q"]);
  applyOverlay(BASE_TREE_DIR, dir);
  const baseOverlay = join(FIXTURES_DIR, name, "base");
  if (existsSync(baseOverlay)) applyOverlay(baseOverlay, dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", BASE_COMMIT_MESSAGE]);
  const baseSha = await git(dir, ["rev-parse", "HEAD"]);

  await git(dir, ["checkout", "-q", "-b", "change"], HEAD_IDENTITY);
  const headOverlay = join(FIXTURES_DIR, name, "head");
  if (existsSync(headOverlay)) applyOverlay(headOverlay, dir);
  for (const path of readDeletions(name)) {
    const target = join(dir, path);
    if (!existsSync(target)) throw new Error(`${name}/deleted.txt: "${path}" does not exist`);
    rmSync(target, { recursive: true });
  }
  await git(dir, ["add", "-A"], HEAD_IDENTITY);
  const staged = await git(dir, ["diff", "--cached", "--name-only"], HEAD_IDENTITY);
  if (staged === "") throw new Error(`fixture "${name}" has no changes between base and head`);
  const message = `${fixture.claim.title}\n\nFixture: ${name}\n`;
  await git(dir, ["commit", "-q", "-m", message], HEAD_IDENTITY);
  const headSha = await git(dir, ["rev-parse", "HEAD"], HEAD_IDENTITY);

  return { dir, baseSha, headSha, fixture };
}

// ---------------------------------------------------------------- merge-queue scenarios

/**
 * Merge-queue scenarios (fixtures/queue/README.md): one base tree and several Changes, each an
 * overlay on the base (or on the Change it depends on, for stacks).
 *
 *   fixtures/queue/_base/                        shared base tree
 *   fixtures/queue/<name>/scenario.json          changes + expectations
 *   fixtures/queue/<name>/base/                  optional overlay on _base
 *   fixtures/queue/<name>/changes/<id>/          overlay forming Change <id>
 *   fixtures/queue/<name>/changes/<id>.deleted.txt  optional paths deleted by Change <id>
 */
export const QUEUE_FIXTURES_DIR = join(FIXTURES_DIR, "queue");
export const QUEUE_BASE_DIR = join(QUEUE_FIXTURES_DIR, "_base");

export type QueueConflictReason = "incomplete" | "config" | "files" | "modules" | "tests";
export const QUEUE_CONFLICT_REASONS: readonly QueueConflictReason[] = [
  "incomplete",
  "config",
  "files",
  "modules",
  "tests",
];

export interface QueueChange {
  /** Short id, also the branch suffix: `change/<id>`. */
  id: string;
  title: string;
  /** The Change this one is stacked on (its branch starts there), or null for main. */
  dependsOn: string | null;
}

/** The AffectedSet fields a scenario pins down (analyzer reports are not compared). */
export interface QueueExpectedAffected {
  files: string[];
  modules: string[];
  testTargets: string[];
  publicApi: boolean;
  deploysTo: string[];
  complete: boolean;
}

export interface QueueConflictExpectation {
  pair: [string, string];
  /** Empty = independent. Order follows QUEUE_CONFLICT_REASONS. */
  reasons: QueueConflictReason[];
}

export interface QueueMergeExpectation {
  changes: string[];
  /** Does `git merge` of these branches onto main succeed without textual conflicts? */
  clean: boolean;
}

export interface QueueOutcomeExpectation {
  /** Changes merged onto main before running the tests ([] = main itself). */
  changes: string[];
  env?: Record<string, string>;
  pass: boolean;
  /** Test files that fail (only when pass is false). */
  failing?: string[];
}

export interface QueueFlaky {
  test: string;
  env: string;
  rate: number;
  failingSeeds: number[];
  passingSeeds: number[];
}

export interface QueueScenario {
  name: string;
  description: string;
  changes: QueueChange[];
  flaky?: QueueFlaky;
  expected: {
    /** Per Change, computed against its parent (main, or the Change it depends on). */
    affected: Record<string, QueueExpectedAffected>;
    /** Every unordered pair of Changes. */
    conflicts: QueueConflictExpectation[];
    merges: QueueMergeExpectation[];
    outcomes: QueueOutcomeExpectation[];
  };
}

const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;

/** Validates a parsed scenario.json. Throws a descriptive error on the first problem. */
export function parseQueueScenario(raw: unknown, file: string): QueueScenario {
  const r = reader(file);
  const fail = (path: string, message: string): never => {
    throw new FixtureSpecError(file, path, message);
  };
  const root = r.object(raw, "");
  r.keys(root, "", ["name", "description", "changes", "flaky", "expected"]);
  if (!Array.isArray(root.changes) || root.changes.length < 2) fail("changes", "needs 2+ changes");
  const changes: QueueChange[] = (root.changes as unknown[]).map((item, i) => {
    const path = `changes[${i}]`;
    const c = r.object(item, path);
    r.keys(c, path, ["id", "title", "dependsOn"]);
    const id = r.string(c.id, `${path}.id`, 1, 31);
    if (!ID_RE.test(id)) fail(`${path}.id`, "must match [a-z][a-z0-9-]*");
    return {
      id,
      title: r.string(c.title, `${path}.title`, 3, 200),
      dependsOn: c.dependsOn === null ? null : r.string(c.dependsOn, `${path}.dependsOn`, 1),
    };
  });
  const ids = changes.map((c) => c.id);
  if (new Set(ids).size !== ids.length) fail("changes", "ids must be unique");
  changes.forEach((c, i) => {
    if (c.dependsOn !== null && !ids.slice(0, i).includes(c.dependsOn))
      fail(`changes[${i}].dependsOn`, "must name an earlier change");
  });
  const known = (id: unknown, path: string): string => {
    const s = r.string(id, path, 1);
    if (!ids.includes(s)) fail(path, `unknown change "${s}"`);
    return s;
  };
  const strings = (v: unknown, path: string): string[] => {
    if (!Array.isArray(v)) return fail(path, "must be an array of strings");
    return v.map((x, i) => r.string(x, `${path}[${i}]`, 1));
  };

  let flaky: QueueFlaky | undefined;
  if (root.flaky !== undefined) {
    const f = r.object(root.flaky, "flaky");
    r.keys(f, "flaky", ["test", "env", "rate", "failingSeeds", "passingSeeds"]);
    const seeds = (v: unknown, path: string): number[] => {
      if (!Array.isArray(v) || v.length === 0 || !v.every((n) => Number.isInteger(n)))
        return fail(path, "must be a non-empty array of integers");
      return v as number[];
    };
    if (typeof f.rate !== "number" || f.rate <= 0 || f.rate >= 1)
      fail("flaky.rate", "must be in (0, 1)");
    flaky = {
      test: r.string(f.test, "flaky.test", 1),
      env: r.string(f.env, "flaky.env", 1),
      rate: f.rate as number,
      failingSeeds: seeds(f.failingSeeds, "flaky.failingSeeds"),
      passingSeeds: seeds(f.passingSeeds, "flaky.passingSeeds"),
    };
  }

  const e = r.object(root.expected, "expected");
  r.keys(e, "expected", ["affected", "conflicts", "merges", "outcomes"]);
  const aff = r.object(e.affected, "expected.affected");
  const affected: Record<string, QueueExpectedAffected> = {};
  for (const id of ids) {
    const path = `expected.affected.${id}`;
    const a = r.object(aff[id], path);
    r.keys(a, path, ["files", "modules", "testTargets", "publicApi", "deploysTo", "complete"]);
    affected[id] = {
      files: strings(a.files, `${path}.files`),
      modules: strings(a.modules, `${path}.modules`),
      testTargets: strings(a.testTargets, `${path}.testTargets`),
      publicApi: r.boolean(a.publicApi, `${path}.publicApi`),
      deploysTo: strings(a.deploysTo, `${path}.deploysTo`),
      complete: r.boolean(a.complete, `${path}.complete`),
    };
  }
  r.keys(aff, "expected.affected", ids);

  if (!Array.isArray(e.conflicts)) fail("expected.conflicts", "must be an array");
  const conflicts = (e.conflicts as unknown[]).map((item, i): QueueConflictExpectation => {
    const path = `expected.conflicts[${i}]`;
    const c = r.object(item, path);
    r.keys(c, path, ["pair", "reasons"]);
    if (!Array.isArray(c.pair) || c.pair.length !== 2) fail(`${path}.pair`, "must be two ids");
    const pair = c.pair as unknown[];
    const reasons = strings(c.reasons, `${path}.reasons`).map((x, j) =>
      r.oneOf(x, `${path}.reasons[${j}]`, QUEUE_CONFLICT_REASONS),
    );
    return {
      pair: [known(pair[0], `${path}.pair[0]`), known(pair[1], `${path}.pair[1]`)],
      reasons,
    };
  });
  const pairKey = (a: string, b: string) => [a, b].sort().join("|");
  const listed = new Set(conflicts.map((c) => pairKey(c.pair[0], c.pair[1])));
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      if (!listed.has(pairKey(ids[i] ?? "", ids[j] ?? "")))
        fail("expected.conflicts", `pair ${ids[i]}/${ids[j]} is missing (list every pair)`);

  const changeList = (v: unknown, path: string): string[] => {
    if (!Array.isArray(v)) return fail(path, "must be an array of change ids");
    return v.map((x, i) => known(x, `${path}[${i}]`));
  };
  if (!Array.isArray(e.merges)) fail("expected.merges", "must be an array");
  const merges = (e.merges as unknown[]).map((item, i): QueueMergeExpectation => {
    const path = `expected.merges[${i}]`;
    const m = r.object(item, path);
    r.keys(m, path, ["changes", "clean"]);
    return {
      changes: changeList(m.changes, `${path}.changes`),
      clean: r.boolean(m.clean, `${path}.clean`),
    };
  });
  if (!Array.isArray(e.outcomes)) fail("expected.outcomes", "must be an array");
  const outcomes = (e.outcomes as unknown[]).map((item, i): QueueOutcomeExpectation => {
    const path = `expected.outcomes[${i}]`;
    const o = r.object(item, path);
    r.keys(o, path, ["changes", "env", "pass", "failing"]);
    const out: QueueOutcomeExpectation = {
      changes: changeList(o.changes, `${path}.changes`),
      pass: r.boolean(o.pass, `${path}.pass`),
    };
    if (o.env !== undefined) {
      const env = r.object(o.env, `${path}.env`);
      out.env = Object.fromEntries(
        Object.entries(env).map(([k, v]) => [k, r.string(v, `${path}.env.${k}`)]),
      );
    }
    if (o.failing !== undefined) out.failing = strings(o.failing, `${path}.failing`);
    if (out.pass && out.failing !== undefined) fail(`${path}.failing`, "only for failing outcomes");
    return out;
  });

  const scenario: QueueScenario = {
    name: r.string(root.name, "name", 1),
    description: r.string(root.description, "description", 1),
    changes,
    expected: { affected, conflicts, merges, outcomes },
  };
  if (flaky !== undefined) scenario.flaky = flaky;
  return scenario;
}

/** Names of all queue scenarios (directories under fixtures/queue with a scenario.json), sorted. */
export function listQueueScenarioNames(): string[] {
  return readdirSync(QUEUE_FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !/^[._]/.test(entry.name))
    .filter((entry) => existsSync(join(QUEUE_FIXTURES_DIR, entry.name, "scenario.json")))
    .map((entry) => entry.name)
    .sort();
}

export function loadQueueScenario(name: string): QueueScenario {
  const file = join(QUEUE_FIXTURES_DIR, name, "scenario.json");
  if (!existsSync(file)) {
    throw new Error(
      `unknown queue scenario "${name}" (known: ${listQueueScenarioNames().join(", ")})`,
    );
  }
  const scenario = parseQueueScenario(
    JSON.parse(readFileSync(file, "utf8")),
    relative(REPO_ROOT, file),
  );
  if (scenario.name !== name) {
    throw new Error(`${file}: name "${scenario.name}" does not match its directory "${name}"`);
  }
  return scenario;
}

export interface MaterializedQueueChange {
  /** `change/<id>`. */
  branch: string;
  sha: string;
  /** The commit the Change was made on: main's base commit, or its dependency's head. */
  parentSha: string;
}

export interface MaterializedQueueScenario {
  /** Absolute path of the git repository (`main` checked out). */
  dir: string;
  /** The base commit on `main`. */
  baseSha: string;
  changes: Record<string, MaterializedQueueChange>;
  scenario: QueueScenario;
}

function readPathList(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * Creates a fresh repository for a queue scenario: `_base` (plus the scenario's `base/`) on
 * `main`, then one branch `change/<id>` per Change, branched from main or from the Change it
 * depends on. Identities and dates are fixed, so SHAs are stable across runs and machines.
 */
export async function materializeQueueScenario(
  name: string,
  options: MaterializeOptions = {},
): Promise<MaterializedQueueScenario> {
  const scenario = loadQueueScenario(name);
  const dir = resolve(options.outDir ?? join(DEFAULT_OUT_DIR, "queue"), name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  await git(dir, ["init", "-q"]);
  applyOverlay(QUEUE_BASE_DIR, dir);
  const baseOverlay = join(QUEUE_FIXTURES_DIR, name, "base");
  if (existsSync(baseOverlay)) applyOverlay(baseOverlay, dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", `Queue scenario base: ${name}`]);
  const baseSha = await git(dir, ["rev-parse", "HEAD"]);

  const changes: Record<string, MaterializedQueueChange> = {};
  for (const change of scenario.changes) {
    const parent = change.dependsOn === null ? null : changes[change.dependsOn];
    const parentSha = parent?.sha ?? baseSha;
    const branch = `change/${change.id}`;
    await git(dir, ["checkout", "-q", "-b", branch, parentSha], HEAD_IDENTITY);
    const overlay = join(QUEUE_FIXTURES_DIR, name, "changes", change.id);
    if (existsSync(overlay)) applyOverlay(overlay, dir);
    const deletedFile = join(QUEUE_FIXTURES_DIR, name, "changes", `${change.id}.deleted.txt`);
    for (const path of readPathList(deletedFile)) {
      const target = join(dir, path);
      if (!existsSync(target))
        throw new Error(`${name}/${change.id}.deleted.txt: "${path}" does not exist`);
      rmSync(target, { recursive: true });
    }
    await git(dir, ["add", "-A"], HEAD_IDENTITY);
    const staged = await git(dir, ["diff", "--cached", "--name-only"], HEAD_IDENTITY);
    if (staged === "")
      throw new Error(`queue scenario "${name}": change "${change.id}" changes nothing`);
    await git(
      dir,
      ["commit", "-q", "-m", `${change.title}\n\nQueue scenario: ${name}/${change.id}\n`],
      HEAD_IDENTITY,
    );
    changes[change.id] = {
      branch,
      sha: await git(dir, ["rev-parse", "HEAD"], HEAD_IDENTITY),
      parentSha,
    };
  }
  await git(dir, ["checkout", "-q", "main"]);
  return { dir, baseSha, changes, scenario };
}
