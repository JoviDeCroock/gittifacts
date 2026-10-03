/**
 * The merge queue's container job program (`QUEUE_JOB_PROGRAM`, build mode) over real git, with a
 * stand-in `gittifacts-runner` whose merge-attempt replays `base..head` as one commit on `onto`.
 * One commit per Change (DECISIONS 2026-10-03): a Change of several commits lands squashed, and
 * its message lists every commit it was made of (M5 dogfood: "lands as one commit with only its
 * last message"); the sha stays deterministic.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { QUEUE_JOB_PROGRAM } from "../../src/adapters/queue-jobs.js";

const root = mkdtempSync(join(tmpdir(), "gf-qjob-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ID = {
  GIT_AUTHOR_NAME: "agent",
  GIT_AUTHOR_EMAIL: "agent@example.dev",
  GIT_AUTHOR_DATE: "1759480000 +0000",
  GIT_COMMITTER_NAME: "agent",
  GIT_COMMITTER_EMAIL: "agent@example.dev",
  GIT_COMMITTER_DATE: "1759480000 +0000",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...ID } }).trim();

/** Stand-in runner: the head's tree on `onto`, with the head's message, as the bot. */
const RUNNER = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const a = process.argv.slice(3);
const arg = (k) => a[a.indexOf(k) + 1];
const git = (...x) => execFileSync("git", x, { encoding: "utf8" }).trim();
const head = arg("--head");
const msg = git("log", "-1", "--format=%B", head);
const env = { ...process.env, GIT_AUTHOR_NAME: "agent", GIT_AUTHOR_EMAIL: "agent@example.dev", GIT_AUTHOR_DATE: "1759480000 +0000", GIT_COMMITTER_NAME: "gittifacts", GIT_COMMITTER_EMAIL: "bot@gittifacts.dev", GIT_COMMITTER_DATE: "1759480000 +0000" };
const newSha = execFileSync("git", ["commit-tree", head + "^{tree}", "-p", arg("--onto"), "-m", msg], { encoding: "utf8", env }).trim();
process.stdout.write("::merge::" + JSON.stringify({ status: "clean", newSha }) + "\\n");
`;

function setup() {
  const origin = join(root, `origin-${Math.random().toString(36).slice(2)}`);
  const work = `${origin}-work`;
  git(root, "init", "-q", "-b", "main", origin);
  git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  writeFileSync(join(origin, "README.md"), "# app\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "base");
  const base = git(origin, "rev-parse", "HEAD");
  const subjects = ["docs: first line", "docs: second line", "docs: fix a typo"];
  subjects.forEach((m, i) => {
    writeFileSync(join(origin, `doc${i}.md`), `${m}\n`);
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", m);
  });
  const head = git(origin, "rev-parse", "HEAD");
  git(root, "clone", "-q", "--depth=1", `file://${origin}`, work);
  const bin = join(root, "bin");
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "gittifacts-runner"), RUNNER);
  chmodSync(join(bin, "gittifacts-runner"), 0o755);
  return { origin, work, base, head, subjects, bin };
}

function build(w: ReturnType<typeof setup>, commits?: number) {
  const plan = {
    mode: "build",
    base: w.base,
    entries: [
      { changeId: "c1", headSha: w.head, replayBase: w.base, ...(commits ? { commits } : {}) },
    ],
    ref: "refs/heads/mq/b1",
    fetch: [w.base, w.head, w.base],
  };
  const program = join(root, "job.mjs");
  writeFileSync(program, QUEUE_JOB_PROGRAM);
  const out = execFileSync("node", [program], {
    cwd: w.work,
    encoding: "utf8",
    env: {
      ...process.env,
      ...ID,
      PATH: `${w.bin}:${process.env.PATH}`,
      GJ_PLAN: JSON.stringify(plan),
    },
  });
  const line = out.split("\n").find((l) => l.startsWith("::gittifacts-job::")) ?? "";
  return JSON.parse(line.slice("::gittifacts-job::".length)) as { status: string; tipSha: string };
}

describe("queue job program: one commit per Change", () => {
  it("lists every commit of a squashed Change, oldest first, deterministically", () => {
    const w = setup();
    const r = build(w, 3);
    expect(r.status).toBe("clean");
    const msg = git(w.origin, "log", "-1", "--format=%B", r.tipSha);
    expect(msg).toContain("docs: fix a typo");
    expect(msg).toContain("squashed from the change's 3 commits (oldest first):");
    const listed = msg.split("\n").filter((l) => l.startsWith("- "));
    expect(listed.map((l) => l.slice(15))).toEqual(w.subjects);
    expect(git(w.origin, "rev-parse", `${r.tipSha}^{tree}`)).toBe(
      git(w.origin, "rev-parse", `${w.head}^{tree}`),
    );
    expect(git(w.origin, "rev-parse", `${r.tipSha}^`)).toBe(w.base);
    expect(build(w, 3).tipSha).toBe(r.tipSha); // a re-run reproduces the sha
  });

  it("a Change of one commit (or with nothing to list) lands as merge-attempt made it", () => {
    const w = setup();
    const r = build(w);
    const msg = git(w.origin, "log", "-1", "--format=%B", r.tipSha);
    expect(msg).toBe("docs: fix a typo");
  });
});

describe("merge queue: one commit per Change (shell over fakes)", () => {
  it("a Change of several commits on an unmoved main is replayed as one commit (not fast-forwarded)", async () => {
    const { queueEnv } = await import("./queue-harness.js");
    const env = await queueEnv();
    const { git } = env.ports;
    const before = git.head("app") ?? "";
    const c1 = await env.change("c1", { "src/b.ts": "export const b = 1;\n" });
    const head = git.commit(
      c1.forkName,
      "main",
      { "src/c.ts": "export const c = 1;\n" },
      "c1: more",
    );
    await env.ports.store.updateChange("c1", { headSha: head });
    await env.admit({ ...c1, headSha: head });
    await env.drive();
    const main = git.head("app") ?? "";
    expect(main).not.toBe(head); // not the Change's own commits
    expect(git.commits.get(main)?.parents).toEqual([before]); // one commit on the old main
    expect(git.commits.get(main)?.tree).toBe(git.commits.get(head)?.tree);
    const build = env.jobs.calls.find((c) => c.op === "buildBatch")?.input as {
      entries: { commits?: number }[];
    };
    expect(build.entries[0]?.commits).toBe(2);
    expect((await env.ports.store.getChange("c1"))?.mergedSha).toBe(main);
  });
});
