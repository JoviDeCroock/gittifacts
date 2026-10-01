/**
 * gittifacts-runner: runs INSIDE the CI sandbox and produces measured evidence for a change.
 *
 * Output contract (see apps/sandbox/README.md):
 * - stdout carries exactly one line, the last: `::evidence::<json>` (`::plan::<json>` for `plan`);
 *   the same JSON is also written to `--out` / `$GITTIFACTS_EVIDENCE_OUT` when set.
 * - Human logs go to stderr.
 * - Exit 0 whenever a document was produced, including `status: "error"` items: a measurement
 *   that failed is reported, never faked. Exit 2 on usage errors, 1 on crashes.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EvidenceItem, type ReproducibleTransform } from "@app/evidence";
import { AFFECTED_PREFIX, affectedCommand } from "./commands/affected.js";
import { coverage } from "./commands/coverage.js";
import { dependencies } from "./commands/dependencies.js";
import { DETECT_PREFIX, detectCommand } from "./commands/detect.js";
import { changeDiff } from "./commands/diff.js";
import {
  coverageError,
  dependenciesError,
  mutationError,
  publicApiError,
  sensitiveError,
  testRunError,
} from "./commands/items.js";
import { applyResolution, mergeAttempt } from "./commands/merge.js";
import { mutation } from "./commands/mutation.js";
import { plan, planEvalChild } from "./commands/plan.js";
import { type PolicyDocument, policy } from "./commands/policy.js";
import { preview, wranglerBinary } from "./commands/preview.js";
import { publicApi } from "./commands/public-api.js";
import { redGreen } from "./commands/red-green.js";
import { sensitivePaths } from "./commands/sensitive-paths.js";
import { testRun } from "./commands/test-run.js";
import { transforms } from "./commands/transforms.js";
import { type Context, createContext, disposeContext, UsageError } from "./lib/context.js";
import { gitText, isSha } from "./lib/git.js";
import { errorMessage, log } from "./lib/log.js";
import { killAllChildren } from "./lib/proc.js";
import { isPackageManager } from "./lib/repo.js";

export const VERSION = "0.1.0";

export const EVIDENCE_PREFIX = "::evidence::";
export const PLAN_PREFIX = "::plan::";
export const PREVIEW_PREFIX = "::preview::";
export const MERGE_PREFIX = "::merge::";
export { AFFECTED_PREFIX, DETECT_PREFIX };

export const EVIDENCE_KINDS = [
  "red-green",
  "coverage",
  "mutation",
  "public-api",
  "dependencies",
  "transforms",
  "sensitive-paths",
  "test-run",
  "policy",
] as const;
export type EvidenceCommand = (typeof EVIDENCE_KINDS)[number];

const USAGE = `gittifacts-runner ${VERSION}: measured evidence for a change, from inside the CI sandbox.

Usage:
  gittifacts-runner evidence <kind> --base <sha> --head <sha> [options]
  gittifacts-runner policy --base <sha> [--head <sha>]
  gittifacts-runner plan [file]            (default file: .platform/ci.ts)
  gittifacts-runner diff --base <sha> --head <sha>
  gittifacts-runner preview [--port 8787] [--ip 0.0.0.0] [--dir dist] [--dry-run]
  gittifacts-runner merge-attempt --base <sha> --onto <sha> --head <sha>
  gittifacts-runner apply-resolution --patch <file> [--onto <sha>]
  gittifacts-runner affected --base <sha> --head <sha> [--coverage-map <file>]
  gittifacts-runner detect [--sha <sha>]   (import detection: ${DETECT_PREFIX}<DetectReport>)

Merge queue:
  merge-attempt     replay base..head onto --onto (3-way, explicit merge base); prints
                    ${MERGE_PREFIX}{status: clean|conflict|error, files[], newSha | conflictSha}
  apply-resolution  apply a resolution patch on --onto (default HEAD; merge-attempt's conflictSha),
                    commit it as gittifacts-resolver and print ${MERGE_PREFIX}{status, newSha}
  affected          the change's AffectedSet (touched files, module closure, test targets,
                    public API, Workers) for the conflict graph: ${AFFECTED_PREFIX}<AffectedSet>

Evidence kinds:
  red-green        new/changed tests: fail on base (head's tests overlaid), pass on head
  coverage         changed-line coverage at head (vitest v8 / jest istanbul)
  mutation         Stryker mutation score on changed lines
  public-api       exported API of TypeScript packages, base vs head (.d.ts surface)
  dependencies     package.json dependency diff + lockfile change
  transforms       re-run .platform/transforms/* (BASE copy) on base, compare with head
  sensitive-paths  changed paths matching the BASE policy's sensitivePaths
  test-run         the whole test suite at head
  policy           base-policy evidence for the CI evidence step: the sensitive-path check
                   (id policy:sensitive-paths), an error item if the base policy is unusable

Options:
  --base <sha>              base commit (default $GITTIFACTS_BASE_SHA)
  --head <sha>              head commit (default $GITTIFACTS_HEAD_SHA, else HEAD); alias --sha
  --cwd <dir>               the checkout (default: current directory)
  --package-manager <pm>    pnpm | npm | yarn | yarn-berry | bun (default: detected)
  --test-command <cmd>      how the repo runs its tests (selects vitest/jest + config flags)
  --out <file>              also write the JSON document here (default $GITTIFACTS_EVIDENCE_OUT)
  --onto <sha>              merge-attempt: the new base; apply-resolution: the commit to resolve
  --patch <file>            apply-resolution: unified diff from --onto to the resolved tree
  --coverage-map <file>     affected: per-test coverage from main's last full run
                            ({test: files[]}, {test: coverage-final.json}, or wrapped)
  --public-api-evidence <file>
                            affected: a public-api evidence item for a precise publicApi
  --port, --ip, --dir       preview: listen address and build output / assets directory
  --dry-run                 preview: print what would be served, don't start it
  -h, --help                show this help
  -v, --version             print the version

Output: the last stdout line is ${EVIDENCE_PREFIX}<json> (${PLAN_PREFIX}<json> for plan); logs go to
stderr. Exit 0 whenever a document was printed, even for status:"error" items.
preview prints ${PREVIEW_PREFIX}<json> once the server answers, then runs until wrangler exits.`;

interface Options {
  base: string | undefined;
  head: string | undefined;
  onto: string | undefined;
  patch: string | undefined;
  coverageMap: string | undefined;
  publicApiEvidence: string | undefined;
  cwd: string;
  packageManager: string | undefined;
  testCommand: string | undefined;
  out: string | undefined;
  port: number;
  ip: string;
  dir: string | undefined;
  dryRun: boolean;
  help: boolean;
  version: boolean;
  positionals: string[];
}

function parse(argv: readonly string[]): Options {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      base: { type: "string" },
      head: { type: "string" },
      // `plan --sha <sha>` (the Runner DO's plan invocation) is `--head`.
      sha: { type: "string" },
      onto: { type: "string" },
      patch: { type: "string" },
      "coverage-map": { type: "string" },
      "public-api-evidence": { type: "string" },
      cwd: { type: "string" },
      "package-manager": { type: "string" },
      "test-command": { type: "string" },
      out: { type: "string" },
      port: { type: "string" },
      ip: { type: "string" },
      dir: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const env = (name: string) => {
    const v = process.env[name];
    return v === undefined || v === "" ? undefined : v;
  };
  return {
    base: values.base ?? env("GITTIFACTS_BASE_SHA"),
    head: values.head ?? values.sha ?? env("GITTIFACTS_HEAD_SHA"),
    onto: values.onto ?? env("GITTIFACTS_ONTO_SHA"),
    patch: values.patch,
    coverageMap: values["coverage-map"] ?? env("GITTIFACTS_COVERAGE_MAP"),
    publicApiEvidence: values["public-api-evidence"],
    cwd: resolve(values.cwd ?? process.cwd()),
    packageManager: values["package-manager"],
    testCommand: values["test-command"],
    out: values.out ?? env("GITTIFACTS_EVIDENCE_OUT"),
    port: values.port === undefined ? 8787 : Number(values.port),
    ip: values.ip ?? "0.0.0.0",
    dir: values.dir,
    dryRun: values["dry-run"] ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
    positionals,
  };
}

function emit(prefix: string, doc: unknown, out: string | undefined): void {
  const json = JSON.stringify(doc);
  if (out !== undefined) {
    try {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${json}\n`);
    } catch (error) {
      log(`could not write ${out}: ${errorMessage(error)}`);
    }
  }
  process.stdout.write(`${prefix}${json}\n`);
}

/** Error document for `kind` when the measurement itself could not run. */
export function errorDocument(
  kind: EvidenceCommand | "policy-document",
  note: string,
  base: string,
  head: string,
): unknown {
  switch (kind) {
    case "red-green":
      return {
        id: "red-green",
        kind: "red-green",
        status: "error",
        note: note.slice(0, 4000),
        tests: [],
        base: { sha: base, results: [] },
        head: { sha: head, results: [] },
        verdict: "not-proven",
      };
    case "coverage":
      return coverageError(note);
    case "mutation":
      return mutationError(note);
    case "public-api":
      return publicApiError(note);
    case "dependencies":
      return dependenciesError(note);
    case "sensitive-paths":
      return sensitiveError(note);
    case "test-run":
      return testRunError(head, note);
    case "transforms": {
      const item: ReproducibleTransform = {
        id: "transform:*",
        kind: "transform",
        status: "error",
        note: note.slice(0, 4000),
        transform: "*",
        command: "",
        verified: false,
        files: [],
        mismatchedFiles: [],
      };
      return [item];
    }
    case "policy":
      return [{ ...sensitiveError(note), id: "policy:sensitive-paths" }];
    case "policy-document": {
      const doc: PolicyDocument = {
        kind: "policy",
        status: "error",
        sha: base,
        path: ".platform/policy.ts",
        source: "file",
        policy: null,
        resolved: null,
        issues: [],
        note: note.slice(0, 4000),
        platformChanged: false,
        platformPaths: [],
        policyChanged: false,
      };
      return doc;
    }
  }
}

async function measure(kind: EvidenceCommand, ctx: Context): Promise<unknown> {
  switch (kind) {
    case "red-green":
      return redGreen(ctx);
    case "coverage":
      return coverage(ctx);
    case "mutation":
      return mutation(ctx);
    case "public-api":
      return publicApi(ctx);
    case "dependencies":
      return dependencies(ctx);
    case "transforms":
      return transforms(ctx);
    case "sensitive-paths":
      return sensitivePaths(ctx);
    case "test-run":
      return testRun(ctx);
    case "policy":
      // The CI evidence channel only carries EvidenceItems: the policy-derived item.
      return [await sensitivePaths(ctx, "policy:sensitive-paths")];
  }
}

/** Items must match the evidence schema; a bug must surface as an error item, not as bad data. */
function validated(kind: EvidenceCommand, doc: unknown, base: string, head: string): unknown {
  const items = Array.isArray(doc) ? doc : [doc];
  for (const item of items) {
    const r = EvidenceItem.safeParse(item);
    if (!r.success) {
      const issue = r.error.issues[0];
      return errorDocument(
        kind,
        `internal error: the runner produced an invalid ${kind} item (${issue?.path.join(".")}: ${issue?.message})`,
        base,
        head,
      );
    }
  }
  return doc;
}

function selfPath(): string {
  const argv1 = process.argv[1];
  if (argv1 !== undefined) {
    try {
      return realpathSync(argv1);
    } catch {
      // fall through
    }
  }
  return fileURLToPath(import.meta.url);
}

export async function main(argv: readonly string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parse(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${USAGE}\n`);
    return 2;
  }
  const [command, ...rest] = opts.positionals;
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (opts.help || command === undefined || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined && !opts.help ? 2 : 0;
  }
  const pmArg = opts.packageManager;
  if (pmArg !== undefined && !isPackageManager(pmArg)) {
    process.stderr.write(`unknown --package-manager ${pmArg}\n`);
    return 2;
  }
  const packageManager = pmArg !== undefined && isPackageManager(pmArg) ? pmArg : null;

  if (command === "__plan-eval") {
    const bundle = rest[0];
    if (bundle === undefined) return 2;
    await planEvalChild(bundle, opts.head ?? null, opts.base ?? null);
    return 0;
  }

  if (command === "preview") {
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      process.stderr.write("--port must be an integer between 1 and 65535\n");
      return 2;
    }
    return preview({
      dir: opts.cwd,
      ip: opts.ip,
      port: opts.port,
      ...(opts.dir === undefined ? {} : { outDir: opts.dir }),
      persistTo: join(
        process.env.GITTIFACTS_PREVIEW_STATE ?? join(tmpdir(), "gittifacts-preview"),
        "state",
      ),
      dryRun: opts.dryRun,
      wrangler: wranglerBinary(),
      emit: (doc) => emit(PREVIEW_PREFIX, doc, opts.out),
    });
  }

  if (command === "plan") {
    const tmp = mkdtempSync(join(tmpdir(), "gittifacts-plan-"));
    try {
      const doc = await plan({
        cwd: opts.cwd,
        file: rest[0] ?? ".platform/ci.ts",
        sha: opts.head ?? null,
        baseSha: opts.base ?? null,
        tmp,
        self: selfPath(),
      });
      emit(PLAN_PREFIX, doc, opts.out);
      return 0;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  if (command === "merge-attempt" || command === "apply-resolution") {
    return mergeCommand(command, opts);
  }

  if (command === "detect") {
    return detectCommand({ cwd: opts.cwd, sha: opts.head }, (doc) =>
      emit(DETECT_PREFIX, doc, opts.out),
    );
  }

  if (command === "affected") {
    return affectedCommand(
      {
        cwd: opts.cwd,
        base: opts.base,
        head: opts.head,
        coverageMap: opts.coverageMap,
        publicApiEvidence: opts.publicApiEvidence,
      },
      (doc) => emit(AFFECTED_PREFIX, doc, opts.out),
    );
  }

  let kind: EvidenceCommand | "diff" | "policy-document";
  if (command === "evidence") {
    const k = rest[0];
    if (k === undefined || !(EVIDENCE_KINDS as readonly string[]).includes(k)) {
      process.stderr.write(
        `unknown evidence kind ${k ?? "(none)"}; one of: ${EVIDENCE_KINDS.join(", ")}\n`,
      );
      return 2;
    }
    kind = k as EvidenceCommand;
  } else if (command === "policy") {
    kind = "policy-document";
  } else if (command === "diff") {
    kind = "diff";
  } else {
    process.stderr.write(`unknown command ${command}\n\n${USAGE}\n`);
    return 2;
  }

  let ctx: Context;
  try {
    ctx = await createContext({
      cwd: opts.cwd,
      base: opts.base,
      head: opts.head,
      packageManager,
      testCommand: opts.testCommand ?? null,
      needsBase: true,
    });
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    // Without both commits nothing can be measured; still report it when we can name them.
    if (
      kind !== "diff" &&
      opts.base !== undefined &&
      opts.head !== undefined &&
      isSha(opts.base) &&
      isSha(opts.head)
    ) {
      log(`cannot prepare the checkout: ${errorMessage(error)}`);
      emit(
        EVIDENCE_PREFIX,
        errorDocument(
          kind,
          `cannot prepare the checkout: ${errorMessage(error)}`,
          opts.base,
          opts.head,
        ),
        opts.out,
      );
      return 0;
    }
    throw error;
  }

  try {
    if (kind === "diff") {
      emit(EVIDENCE_PREFIX, await changeDiff(ctx), opts.out);
      return 0;
    }
    if (kind === "policy-document") {
      let policyDoc: unknown;
      try {
        policyDoc = await policy(ctx);
      } catch (error) {
        log(
          `policy failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        policyDoc = errorDocument(
          kind,
          `evaluating the base policy failed: ${errorMessage(error)}`,
          ctx.base,
          ctx.head,
        );
      }
      emit(EVIDENCE_PREFIX, policyDoc, opts.out);
      return 0;
    }
    let doc: unknown;
    try {
      doc = await measure(kind, ctx);
    } catch (error) {
      log(
        `${kind} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      doc = errorDocument(
        kind,
        `${kind} measurement failed: ${errorMessage(error)}`,
        ctx.base,
        ctx.head,
      );
    }
    emit(EVIDENCE_PREFIX, validated(kind, doc, ctx.base, ctx.head), opts.out);
    return 0;
  } finally {
    disposeContext(ctx);
  }
}

/** merge-attempt / apply-resolution: one `::merge::` document; exit 0 even for status "error". */
async function mergeCommand(
  command: "merge-attempt" | "apply-resolution",
  opts: Options,
): Promise<number> {
  const missing =
    command === "merge-attempt"
      ? (["base", "onto", "head"] as const).filter((k) => opts[k] === undefined)
      : opts.patch === undefined
        ? ["patch"]
        : [];
  if (missing.length > 0) {
    process.stderr.write(`${command} needs ${missing.map((m) => `--${m}`).join(", ")}\n`);
    return 2;
  }
  let repo: string;
  try {
    repo = (await gitText(opts.cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    process.stderr.write(`not a git checkout: ${errorMessage(error)}\n`);
    return 2;
  }
  const tmp = mkdtempSync(join(process.env.GITTIFACTS_TMPDIR ?? tmpdir(), "gittifacts-merge-"));
  try {
    const doc =
      command === "merge-attempt"
        ? await mergeAttempt({
            repo,
            tmp,
            base: opts.base ?? "",
            onto: opts.onto ?? "",
            head: opts.head ?? "",
          })
        : await applyResolution({
            repo,
            tmp,
            onto: opts.onto ?? "HEAD",
            patch: resolve(opts.cwd, opts.patch ?? ""),
          });
    emit(MERGE_PREFIX, doc, opts.out);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function onSignal(signal: NodeJS.Signals): void {
  log(`received ${signal}; stopping child processes`);
  killAllChildren("SIGTERM");
  setTimeout(() => {
    killAllChildren("SIGKILL");
    process.exit(signal === "SIGINT" ? 130 : 143);
  }, 2_000).unref();
}

const isEntry = (() => {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntry) {
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      log(`crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exitCode = 1;
    },
  );
}
