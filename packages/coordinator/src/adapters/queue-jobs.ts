/**
 * `QueueJobs` on the ci-engine `Runner` Durable Object (same RPC contract as
 * `ContainerSandboxJobs`). Every job checks out the queue's scratch repo (`mqs-<repoId>`), gets a
 * write token for that scratch repo ONLY (env-config, never argv; ≤ 600 s), runs a small Node
 * program around `gittifacts-runner merge-attempt | apply-resolution` and pushes what it built to
 * a scratch ref. Inputs are copied into the scratch repo first (`transferObjects`), so containers
 * never talk to a main repo or a Change's fork. Documents larger than the 16 KiB output tail are
 * read back from the job's R2 log (`readLog`).
 */
import { z } from "zod";
import { newId } from "../ids.js";
import type { GitHost } from "../ports.js";
import { BuildResult, type QueueJobs, type ReplaySpec } from "../queue/jobs.js";
import { lastMarked, RESULT_PREFIX, type RunnerLike } from "./container-sandbox-jobs.js";

export interface ContainerQueueJobsOptions {
  runner(name: string): RunnerLike;
  git: Pick<GitHost, "remoteOf" | "mintToken" | "transferObjects" | "forkRepo" | "branchHead">;
  logKey(jobId: string, step: string): string;
  /** Full text of a job log (R2 `CI_BUCKET`), for documents that do not fit the output tail. */
  readLog(key: string): Promise<string | null>;
  newJobId?: () => string;
}

const RunOutcome = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      exitCode: z.number(),
      timedOut: z.boolean(),
      tail: z.string(),
      log: z.object({ key: z.string() }).passthrough().nullable().optional(),
    })
    .passthrough(),
  z
    .object({ ok: z.literal(false), code: z.string(), message: z.string(), tail: z.string() })
    .passthrough(),
]);

const IN_REF = "refs/gittifacts/mq/in";

/**
 * The job program (ESM, run with node in /workspace). `GJ_PLAN` is its JSON input. It prints one
 * `::gittifacts-job::` result line, and re-prints the runner's `::merge::` document when asked.
 */
export const QUEUE_JOB_PROGRAM = String.raw`
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const plan = JSON.parse(process.env.GJ_PLAN);
const RESULT = "::gittifacts-job::";
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 512 << 20, stdio: ["ignore", "pipe", "inherit"] });
const git = (...a) => run("git", a).trim();
const out = (o) => process.stdout.write(RESULT + JSON.stringify(o) + "\n");
const doc = (text) => {
  const line = text.split("\n").reverse().find((l) => l.startsWith("::merge::"));
  if (line === undefined) throw new Error("no ::merge:: document");
  return { line, value: JSON.parse(line.slice(9)) };
};
// Full objects (--no-filter), one commit deep each: the checkout is blobless and merge-attempt runs
// with lazy fetching off, so every blob a replay reads has to be here before it starts. A failed fetch
// fails the job (it used to be swallowed, and the replay then died on a missing blob).
for (const sha of plan.fetch) git("fetch", "-q", "--no-tags", "--no-filter", "--depth=1", "origin", sha);
const replay = (e, onto) => doc(run("gittifacts-runner", ["merge-attempt", "--base", e.replayBase, "--onto", onto, "--head", e.headSha]));
const tree = (sha) => git("rev-parse", sha + "^{tree}");
const push = (sha, ref) => git("push", "-q", "--force", "origin", sha + ":" + ref);
// One commit per Change (DECISIONS 2026-10-03): a Change of several commits lands squashed, and its
// message keeps the head's message and lists every commit it was made of, oldest first. Same tree,
// parent, identities and dates as merge-attempt's commit, so a re-run reproduces the sha. Best
// effort: if the history can't be read, merge-attempt's commit lands as it is.
const squashed = (e, sha, onto) => {
  if (!(e.commits > 1)) return sha;
  try {
    git("fetch", "-q", "--no-tags", "--no-filter", "--depth=" + e.commits, "origin", e.headSha);
    const list = git("log", "--format=%H %s", "-n", String(e.commits), e.headSha).split("\n").filter(Boolean).reverse();
    if (list.length !== e.commits) return sha;
    const [an, ae, ad, cn, ce, cd, ...body] = run("git", ["log", "-1", "--date=raw", "--format=%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%B", sha]).split("\0");
    const lines = list.map((l) => "- " + l.slice(0, 12) + l.slice(40));
    writeFileSync("/tmp/gittifacts-squash-msg", body.join("\0").trimEnd() + "\n\nLanded by the merge queue as one commit, squashed from the change's " + e.commits + " commits (oldest first):\n" + lines.join("\n") + "\n");
    const env = { ...process.env, GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad, GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce, GIT_COMMITTER_DATE: cd };
    return execFileSync("git", ["commit-tree", tree(sha), "-p", onto, "-F", "/tmp/gittifacts-squash-msg"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "inherit"] }).trim();
  } catch {
    return sha;
  }
};
if (plan.mode === "build") {
  let tip = plan.base;
  const commits = [];
  for (const e of plan.entries) {
    const d = replay(e, tip).value;
    if (d.status === "clean") { tip = squashed(e, d.newSha, tip); commits.push({ changeId: e.changeId, commitSha: tip, treeSha: tree(tip) }); continue; }
    if (d.status === "conflict") { out({ status: "conflict", changeId: e.changeId, files: d.files.map((f) => f.path), upstreamCommits: (d.upstreamCommits || []).map((c) => c.sha) }); process.exit(0); }
    out({ status: "error", changeId: e.changeId, note: String(d.note || "merge-attempt failed").slice(0, 2000) }); process.exit(0);
  }
  push(tip, plan.ref);
  out({ status: "clean", tipSha: tip, treeSha: commits[commits.length - 1].treeSha, commits });
} else if (plan.mode === "attempt") {
  let onto = plan.onto;
  for (const e of plan.preceding) {
    const d = replay(e, onto).value;
    if (d.status !== "clean") { out({ status: "error", changeId: e.changeId, note: "preceding entry " + e.changeId + " does not apply: " + d.status }); process.exit(0); }
    onto = d.newSha;
  }
  const d = replay(plan.change, onto);
  const target = d.value.status === "conflict" ? d.value.conflictSha : d.value.newSha;
  if (target) push(target, plan.ref);
  out({ status: "attempt", ontoSha: onto });
  process.stdout.write(d.line + "\n");
} else if (plan.mode === "apply") {
  writeFileSync("/tmp/gittifacts-resolution.patch", Buffer.from(plan.patch, "base64"));
  const d = doc(run("gittifacts-runner", ["apply-resolution", "--patch", "/tmp/gittifacts-resolution.patch", "--onto", plan.onto]));
  if (d.value.status === "resolved") push(d.value.newSha, plan.ref);
  out({ status: "applied" });
  process.stdout.write(d.line + "\n");
}
`;

const JOB_COMMAND = [
  "set -eu",
  "cd /workspace",
  `printf '%s' "$GJ_PROGRAM" > /tmp/gittifacts-queue-job.mjs`,
  "node /tmp/gittifacts-queue-job.mjs",
].join("\n");

export class ContainerQueueJobs implements QueueJobs {
  constructor(private readonly opts: ContainerQueueJobsOptions) {}

  async ensureScratch(input: { mainRepo: string; scratch: string }): Promise<void> {
    // forkRepo is idempotent per target in the Artifacts adapter (an existing fork is reused).
    await this.opts.git.forkRepo(input.mainRepo, input.scratch);
  }

  /** Copy every input head (and the base) into the scratch repo. */
  private async stage(scratch: string, specs: ReplaySpec[], base?: { repo: string; sha: string }) {
    if (base !== undefined && base.repo !== scratch)
      await this.opts.git.transferObjects(base.repo, scratch, base.sha, `${IN_REF}/base`);
    for (const s of specs)
      if (s.repo !== scratch)
        await this.opts.git.transferObjects(s.repo, scratch, s.headSha, `${IN_REF}/${s.changeId}`);
  }

  private async exec(kind: string, scratch: string, headSha: string, plan: unknown) {
    const jobId = `job-mq-${kind}-${(this.opts.newJobId ?? newId)()}`;
    const { token } = await this.opts.git.mintToken(scratch, "write", 600);
    const raw = await this.opts.runner(`${jobId}:${kind}`).run({
      runId: jobId,
      step: kind,
      kind: "user",
      attempt: 1,
      command: JOB_COMMAND,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
        GIT_TERMINAL_PROMPT: "0",
        GJ_PROGRAM: QUEUE_JOB_PROGRAM,
        GJ_PLAN: JSON.stringify(plan),
      },
      instance: "lite",
      timeoutSeconds: 900,
      artifactsRepo: scratch,
      remote: this.opts.git.remoteOf(scratch),
      headSha,
      from: { kind: "image" },
      replay: [],
      snapshot: false,
      logKey: this.opts.logKey(jobId, kind),
    });
    const outcome = RunOutcome.parse(raw);
    if (!outcome.ok)
      throw new Error(`queue ${kind} job failed (${outcome.code}): ${outcome.message}`);
    if (outcome.timedOut) throw new Error(`queue ${kind} job timed out`);
    if (outcome.exitCode !== 0)
      throw new Error(`queue ${kind} job exited ${outcome.exitCode}: ${outcome.tail.slice(-500)}`);
    return { tail: outcome.tail, logKey: outcome.log?.key ?? null };
  }

  /** The last `<prefix>` document, from the tail or (when cut off) the full log. */
  private async marked(out: { tail: string; logKey: string | null }, prefix: string) {
    const fromTail = safeMarked(out.tail, prefix);
    if (fromTail !== undefined) return fromTail;
    const log = out.logKey === null ? null : await this.opts.readLog(out.logKey);
    const fromLog = log === null ? undefined : safeMarked(log, prefix);
    if (fromLog === undefined) throw new Error(`queue job printed no ${prefix} line`);
    return fromLog;
  }

  async buildBatch(input: {
    scratch: string;
    baseRepo: string;
    baseSha: string;
    entries: ReplaySpec[];
    ref: string;
  }) {
    await this.stage(input.scratch, input.entries, { repo: input.baseRepo, sha: input.baseSha });
    const out = await this.exec("build", input.scratch, input.baseSha, {
      mode: "build",
      base: input.baseSha,
      entries: input.entries.map(({ changeId, headSha, replayBase, commits }) => ({
        changeId,
        headSha,
        replayBase,
        ...(commits === undefined ? {} : { commits }),
      })),
      ref: input.ref,
      fetch: [input.baseSha, ...input.entries.flatMap((e) => [e.headSha, e.replayBase])],
    });
    return BuildResult.parse(await this.marked(out, RESULT_PREFIX));
  }

  async affected(input: { repo: string; baseSha: string; headSha: string }) {
    // `affected` only reads git objects: run it directly (no program, no push token needed).
    const jobId = `job-mq-affected-${(this.opts.newJobId ?? newId)()}`;
    const raw = await this.opts.runner(`${jobId}:affected`).run({
      runId: jobId,
      step: "affected",
      kind: "user",
      attempt: 1,
      command: `gittifacts-runner affected --base ${input.baseSha} --head ${input.headSha}`,
      env: {},
      instance: "lite",
      timeoutSeconds: 600,
      artifactsRepo: input.repo,
      remote: this.opts.git.remoteOf(input.repo),
      headSha: input.headSha,
      baseSha: input.baseSha,
      from: { kind: "image" },
      replay: [],
      snapshot: false,
      logKey: this.opts.logKey(jobId, "affected"),
    });
    const outcome = RunOutcome.parse(raw);
    if (!outcome.ok) throw new Error(`affected job failed (${outcome.code}): ${outcome.message}`);
    if (outcome.exitCode !== 0) throw new Error(`affected job exited ${outcome.exitCode}`);
    return this.marked({ tail: outcome.tail, logKey: outcome.log?.key ?? null }, "::affected::");
  }

  async mergeAttempt(input: {
    scratch: string;
    baseRepo: string;
    ontoSha: string;
    preceding: ReplaySpec[];
    change: ReplaySpec;
    ref: string;
  }) {
    const specs = [...input.preceding, input.change];
    await this.stage(input.scratch, specs, { repo: input.baseRepo, sha: input.ontoSha });
    const out = await this.exec("attempt", input.scratch, input.ontoSha, {
      mode: "attempt",
      onto: input.ontoSha,
      preceding: input.preceding.map(({ changeId, headSha, replayBase }) => ({
        changeId,
        headSha,
        replayBase,
      })),
      change: {
        changeId: input.change.changeId,
        headSha: input.change.headSha,
        replayBase: input.change.replayBase,
      },
      ref: input.ref,
      fetch: [input.ontoSha, ...specs.flatMap((e) => [e.headSha, e.replayBase])],
    });
    const head = z
      .discriminatedUnion("status", [
        z.object({ status: z.literal("attempt"), ontoSha: z.string() }),
        z.object({ status: z.literal("error"), changeId: z.string().nullable(), note: z.string() }),
      ])
      .parse(await this.marked(out, RESULT_PREFIX));
    if (head.status === "error") throw new Error(head.note);
    return { ontoSha: head.ontoSha, doc: await this.marked(out, "::merge::") };
  }

  async applyResolution(input: { scratch: string; patch: string; onto: string; ref: string }) {
    const bytes = new TextEncoder().encode(input.patch);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const out = await this.exec("apply", input.scratch, input.onto, {
      mode: "apply",
      onto: input.onto,
      ref: input.ref,
      patch: btoa(binary),
      fetch: [input.onto],
    });
    return this.marked(out, "::merge::");
  }
}

function safeMarked(text: string, prefix: string): unknown {
  try {
    return lastMarked(text, prefix);
  } catch {
    return undefined; // a cut-off line: read the full log instead
  }
}
