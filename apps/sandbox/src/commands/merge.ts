/**
 * Merge-queue git jobs: replay a Change onto a new base (`merge-attempt`) and commit a conflict
 * resolution (`apply-resolution`). Both work in a throwaway worktree, never touch the checkout's
 * HEAD, and print one `::merge::<json>` document.
 *
 * merge-attempt replays `base..head` as ONE commit onto `onto` with an explicit merge base: it
 * cherry-picks a synthetic commit (head's tree, parent base), so the 3-way merge base is exactly
 * `base` (git 2.39 has no `merge-tree --merge-base`). Content conflicts are then re-merged with
 * `git merge-file --diff3` using fixed labels and an unusual marker size, so the markers can be
 * told apart from file content: `<<<<<<<<<<<<< upstream`, `||||||||||||| base`, `=============`,
 * `>>>>>>>>>>>>> change`. "ours" is the upstream side (`--onto`), "theirs" the Change (`--head`).
 *
 * Commits are deterministic (identities and dates come from the inputs), so re-running a job in
 * a fresh container reproduces the same SHAs.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addWorktree, ensureCommit, git, gitText, removeWorktree } from "../lib/git.js";
import { errorMessage, log } from "../lib/log.js";

export const MERGE_MARKERS = {
  size: 13,
  ours: "upstream",
  base: "base",
  theirs: "change",
} as const;

/** Sides larger than this are not inlined (the resolver ejects instead). */
export const MAX_INLINE_BYTES = 512 * 1024;

const BOT = { name: "gittifacts", email: "bot@gittifacts.dev" };
export const RESOLVER_IDENTITY = { name: "gittifacts-resolver", email: "resolver@gittifacts.dev" };

export type ConflictKind = "content" | "add-add" | "modify-delete" | "other";

export interface ConflictFile {
  path: string;
  kind: ConflictKind;
  /** File mode of the surviving side, e.g. "100644". */
  mode: string;
  /** Not text (NUL bytes, invalid UTF-8) or a submodule: contents are not inlined. */
  binary: boolean;
  /** A side is over MAX_INLINE_BYTES: contents are not inlined. */
  tooLarge: boolean;
  base: string | null;
  /** The upstream side (`--onto`). */
  ours: string | null;
  /** The Change's side (`--head`). */
  theirs: string | null;
  /** What the conflict commit holds: the merge with markers, or the surviving side. */
  merged_with_markers: string | null;
}

export interface UpstreamCommit {
  sha: string;
  subject: string;
}

export type MergeAttemptDocument =
  | {
      status: "clean";
      base: string;
      onto: string;
      head: string;
      newSha: string;
      files: [];
      markers: typeof MERGE_MARKERS;
      upstreamCommits: UpstreamCommit[];
      messages: string[];
    }
  | {
      status: "conflict";
      base: string;
      onto: string;
      head: string;
      /** A commit on `onto` whose tree holds the conflicted files as `merged_with_markers`. */
      conflictSha: string;
      files: ConflictFile[];
      markers: typeof MERGE_MARKERS;
      /** Commits in base..onto that touched a conflicted path (newest first, at most 50). */
      upstreamCommits: UpstreamCommit[];
      messages: string[];
    }
  | {
      status: "error";
      base: string | null;
      onto: string | null;
      head: string | null;
      note: string;
      files: [];
    };

export type ApplyResolutionDocument =
  | { status: "resolved"; parentSha: string; newSha: string; files: string[] }
  | { status: "error"; parentSha: string | null; note: string; files: string[] };

interface Identity {
  name: string;
  email: string;
  /** Raw git date: "<unix seconds> <tz>". */
  date: string;
}

function identityEnv(author: Identity, committer: Identity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: author.date,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
    GIT_COMMITTER_DATE: committer.date,
  };
}

async function commitInfo(
  repo: string,
  sha: string,
): Promise<{ author: Identity; committerDate: string; message: string }> {
  const out = await gitText(repo, [
    "log",
    "-1",
    "--format=%an%x00%ae%x00%ad%x00%cd%x00%B",
    "--date=raw",
    sha,
  ]);
  const [name = "", email = "", date = "", committerDate = "", ...rest] = out.split("\0");
  return {
    author: { name, email, date },
    committerDate,
    message: rest.join("\0").trimEnd(),
  };
}

async function commitTree(
  repo: string,
  tree: string,
  parent: string,
  message: string,
  author: Identity,
  committer: Identity,
): Promise<string> {
  const out = await gitText(repo, ["commit-tree", tree, "-p", parent, "-F", "-"], {
    input: `${message}\n`,
    env: identityEnv(author, committer),
  });
  return out.trim();
}

function isText(content: string): boolean {
  return !content.slice(0, 8000).includes("\0") && !content.includes("�");
}

/** Blob content as text, or a reason it is not inlined. */
async function blobText(
  repo: string,
  sha: string,
): Promise<{ text: string | null; binary: boolean; tooLarge: boolean }> {
  const size = Number((await gitText(repo, ["cat-file", "-s", sha])).trim());
  if (!Number.isFinite(size) || size > MAX_INLINE_BYTES)
    return { text: null, binary: false, tooLarge: true };
  const text = await gitText(repo, ["cat-file", "blob", sha]);
  return isText(text)
    ? { text, binary: false, tooLarge: false }
    : { text: null, binary: true, tooLarge: false };
}

interface Stage {
  mode: string;
  sha: string;
}

/** `git ls-files -u -z`, grouped: path → stage (1 base, 2 ours, 3 theirs). */
async function unmerged(worktree: string): Promise<Map<string, Map<number, Stage>>> {
  const out = await gitText(worktree, ["ls-files", "-u", "-z"]);
  const byPath = new Map<string, Map<number, Stage>>();
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode = "", sha = "", stage = "0"] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    const stages = byPath.get(path) ?? new Map<number, Stage>();
    stages.set(Number(stage), { mode, sha });
    byPath.set(path, stages);
  }
  return byPath;
}

function kindOf(stages: Map<number, Stage>): ConflictKind {
  const has = (n: number) => stages.has(n);
  if (has(1) && has(2) && has(3)) return "content";
  if (!has(1) && has(2) && has(3)) return "add-add";
  if (has(1) && has(2) !== has(3)) return "modify-delete";
  return "other";
}

async function mergeFile(
  worktree: string,
  scratch: string,
  stages: Map<number, Stage>,
): Promise<string | null> {
  mkdirSync(scratch, { recursive: true });
  const write = async (n: number, name: string): Promise<string> => {
    const file = join(scratch, name);
    const stage = stages.get(n);
    if (stage === undefined) writeFileSync(file, "");
    else {
      // Only text sides are merged (see isText), so the UTF-8 round trip is exact.
      const r = await git(worktree, ["cat-file", "blob", stage.sha]);
      writeFileSync(file, r.stdout);
    }
    return file;
  };
  const ours = await write(2, "ours");
  const base = await write(1, "base");
  const theirs = await write(3, "theirs");
  const r = await git(
    worktree,
    [
      "merge-file",
      "-p",
      "--diff3",
      `--marker-size=${MERGE_MARKERS.size}`,
      "-L",
      MERGE_MARKERS.ours,
      "-L",
      MERGE_MARKERS.base,
      "-L",
      MERGE_MARKERS.theirs,
      ours,
      base,
      theirs,
    ],
    { allowFail: true },
  );
  // Exit status is the number of conflicts (>= 0); negative/large values are errors.
  if (r.code < 0 || r.code > 127) return null;
  return r.stdout;
}

function conflictMessages(output: string): string[] {
  return output
    .split("\n")
    .filter((l) => l.startsWith("CONFLICT ("))
    .map((l) => l.trim().slice(0, 500))
    .slice(0, 200);
}

export interface MergeAttemptInput {
  repo: string;
  tmp: string;
  base: string;
  onto: string;
  head: string;
}

/** Replay base..head onto `onto` (see the module doc). */
export async function mergeAttempt(input: MergeAttemptInput): Promise<MergeAttemptDocument> {
  const { repo, tmp } = input;
  let base: string | null = null;
  let onto: string | null = null;
  let head: string | null = null;
  try {
    base = await ensureCommit(repo, input.base);
    onto = await ensureCommit(repo, input.onto);
    head = await ensureCommit(repo, input.head);
  } catch (error) {
    return {
      status: "error",
      base,
      onto,
      head,
      note: `cannot resolve the commits: ${errorMessage(error)}`,
      files: [],
    };
  }
  const info = await commitInfo(repo, head);
  const bot: Identity = { ...BOT, date: info.committerDate };
  // The Change as one commit whose parent is its base: cherry-picking it merges with base as the
  // merge base, whatever the history between base and onto looks like.
  const headTree = (await gitText(repo, ["rev-parse", `${head}^{tree}`])).trim();
  const squash = await commitTree(repo, headTree, base, `gittifacts change ${head}`, bot, bot);

  const worktree = join(tmp, "merge");
  await addWorktree(repo, worktree, onto);
  try {
    const pick = await git(
      worktree,
      [
        "-c",
        "merge.conflictStyle=diff3",
        "-c",
        `user.name=${BOT.name}`,
        "-c",
        `user.email=${BOT.email}`,
        "cherry-pick",
        "--no-commit",
        "--allow-empty",
        squash,
      ],
      { allowFail: true, env: identityEnv(bot, bot) },
    );
    const messages = conflictMessages(`${pick.stdout}\n${pick.stderr}`);
    const conflicts = await unmerged(worktree);
    if (pick.code !== 0 && conflicts.size === 0) {
      return {
        status: "error",
        base,
        onto,
        head,
        note: `git cherry-pick failed without conflicts: ${(pick.stderr || pick.stdout).trim().slice(0, 2000)}`,
        files: [],
      };
    }
    const committer: Identity = { ...BOT, date: info.committerDate };
    if (conflicts.size === 0) {
      const tree = (await gitText(worktree, ["write-tree"])).trim();
      const newSha = await commitTree(repo, tree, onto, info.message, info.author, committer);
      log(`merge-attempt: clean, ${newSha.slice(0, 12)}`);
      return {
        status: "clean",
        base,
        onto,
        head,
        newSha,
        files: [],
        markers: MERGE_MARKERS,
        upstreamCommits: [],
        messages,
      };
    }

    const files: ConflictFile[] = [];
    let n = 0;
    for (const [path, stages] of [...conflicts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const kind = kindOf(stages);
      const mode = (stages.get(3) ?? stages.get(2) ?? stages.get(1))?.mode ?? "100644";
      const side = async (k: number) => {
        const s = stages.get(k);
        return s === undefined
          ? { text: null, binary: false, tooLarge: false }
          : blobText(worktree, s.sha);
      };
      const [b, o, t] = [await side(1), await side(2), await side(3)];
      const binary = mode === "160000" || b.binary || o.binary || t.binary;
      const tooLarge = b.tooLarge || o.tooLarge || t.tooLarge;
      const full = join(worktree, path);
      let merged: string | null = null;
      if (!binary && !tooLarge && (kind === "content" || kind === "add-add")) {
        merged = await mergeFile(worktree, join(tmp, `mf-${n++}`), stages);
      }
      if (merged !== null) {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, merged);
        await git(worktree, ["add", "--", path]);
      } else {
        // Whole-file conflict: keep what git left in the tree (the surviving side), if anything.
        let left: string | null = null;
        try {
          left = readFileSync(full, "utf8");
        } catch {
          left = null;
        }
        if (left === null)
          await git(worktree, ["rm", "-q", "--cached", "--ignore-unmatch", "--", path]);
        else await git(worktree, ["add", "--", path]);
        merged = binary || tooLarge || left === null || !isText(left) ? null : left;
      }
      files.push({
        path,
        kind,
        mode,
        binary,
        tooLarge,
        base: b.text,
        ours: o.text,
        theirs: t.text,
        merged_with_markers: merged,
      });
    }
    const tree = (await gitText(worktree, ["write-tree"])).trim();
    const message = `${info.message}\n\nGittifacts-Conflicts: ${files.length} file(s) with unresolved conflicts; a resolution commit must follow.`;
    const conflictSha = await commitTree(repo, tree, onto, message, info.author, committer);
    const log1 = await gitText(repo, [
      "log",
      "--format=%H%x09%s",
      "-n",
      "50",
      `${base}..${onto}`,
      "--",
      ...files.map((f) => f.path),
    ]);
    const upstreamCommits = log1
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        const tab = l.indexOf("\t");
        return { sha: l.slice(0, tab), subject: l.slice(tab + 1).slice(0, 300) };
      });
    log(
      `merge-attempt: ${files.length} conflicted file(s), conflict commit ${conflictSha.slice(0, 12)}`,
    );
    return {
      status: "conflict",
      base,
      onto,
      head,
      conflictSha,
      files,
      markers: MERGE_MARKERS,
      upstreamCommits,
      messages,
    };
  } finally {
    await removeWorktree(repo, worktree);
  }
}

export interface ApplyResolutionInput {
  repo: string;
  tmp: string;
  /** The commit to resolve: merge-attempt's conflictSha (or newSha for a semantic conflict). */
  onto: string;
  /** Path of a unified diff (`git apply` format) from that commit to the resolved tree. */
  patch: string;
}

/** The marker lines merge-attempt writes; any left after a resolution means it is unresolved. */
export function markerLines(): string[] {
  const m = MERGE_MARKERS;
  return [
    `${"<".repeat(m.size)} ${m.ours}`,
    `${"|".repeat(m.size)} ${m.base}`,
    `${">".repeat(m.size)} ${m.theirs}`,
  ];
}

/** Apply a resolution patch on `onto` and commit it as the resolver (see the module doc). */
export async function applyResolution(
  input: ApplyResolutionInput,
): Promise<ApplyResolutionDocument> {
  const { repo, tmp } = input;
  let parent: string;
  try {
    parent = await ensureCommit(repo, input.onto);
  } catch (error) {
    return {
      status: "error",
      parentSha: null,
      note: `cannot resolve --onto: ${errorMessage(error)}`,
      files: [],
    };
  }
  let patch: string;
  try {
    patch = readFileSync(input.patch, "utf8");
  } catch (error) {
    return {
      status: "error",
      parentSha: parent,
      note: `cannot read --patch: ${errorMessage(error)}`,
      files: [],
    };
  }
  const worktree = join(tmp, "resolve");
  await addWorktree(repo, worktree, parent);
  try {
    const patchFile = join(tmp, "resolution.patch");
    writeFileSync(patchFile, patch);
    // An empty patch is a valid resolution: the merge-attempt commit already holds the answer
    // (e.g. a modify/delete conflict resolved by keeping the surviving side). It is still
    // committed, so the resolver's decision is recorded and attributable.
    const applied =
      patch.trim() === ""
        ? { code: 0, stderr: "" }
        : await git(worktree, ["apply", "--index", "--whitespace=nowarn", patchFile], {
            allowFail: true,
          });
    if (applied.code !== 0) {
      return {
        status: "error",
        parentSha: parent,
        note: `the resolution patch does not apply: ${applied.stderr.trim().slice(0, 2000)}`,
        files: [],
      };
    }
    const files = (await gitText(worktree, ["diff", "--cached", "--name-only", "-z", parent]))
      .split("\0")
      .filter((p) => p !== "");
    const grep = await git(
      worktree,
      ["grep", "--cached", "-l", "-I", "-F", ...markerLines().flatMap((m) => ["-e", m])],
      { allowFail: true },
    );
    const leftover = grep.stdout.split("\n").filter((l) => l.trim() !== "");
    if (leftover.length > 0) {
      return {
        status: "error",
        parentSha: parent,
        note: `unresolved conflict markers remain in: ${leftover.slice(0, 20).join(", ")}`,
        files,
      };
    }
    const tree = (await gitText(worktree, ["write-tree"])).trim();
    const parentInfo = await commitInfo(repo, parent);
    const who: Identity = { ...RESOLVER_IDENTITY, date: parentInfo.committerDate };
    const message = [
      "Resolve merge conflicts",
      "",
      "Written by the merge queue's resolver agent (system:resolver), not by the change's author.",
      "",
      "Gittifacts-Resolver: system:resolver",
    ].join("\n");
    const newSha = await commitTree(repo, tree, parent, message, who, who);
    log(
      `apply-resolution: ${newSha.slice(0, 12)} on ${parent.slice(0, 12)} (${files.length} file(s))`,
    );
    return { status: "resolved", parentSha: parent, newSha, files };
  } finally {
    await removeWorktree(repo, worktree);
    rmSync(join(tmp, "resolution.patch"), { force: true });
  }
}
