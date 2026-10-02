/**
 * In-memory `QueueJobs` on `FakeGitHost`: file-level three-way merges stand in for
 * `gittifacts-runner merge-attempt` (a path both sides changed differently conflicts), and a
 * simple analyzer stands in for `affected` (touched files; `x.ts` is covered by `x.test.ts`).
 * Commits land in the scratch repo exactly like the container jobs push them.
 */
import type { QueueJobs, ReplaySpec } from "../queue/jobs.js";
import type { FakeGitHost, Files } from "./git-host.js";

export type MergeOutcome =
  | { status: "clean"; files: Record<string, string> }
  | { status: "conflict"; files: string[] };

/** Replay `base → head` onto `onto`, path by path. */
export function mergeFiles(base: Files, head: Files, onto: Files): MergeOutcome {
  const merged: Record<string, string> = { ...onto };
  const conflicts: string[] = [];
  for (const path of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (base[path] === head[path]) continue; // the Change did not touch it
    if (onto[path] === base[path] || onto[path] === head[path]) {
      const v = head[path];
      if (v === undefined) delete merged[path];
      else merged[path] = v;
    } else conflicts.push(path);
  }
  return conflicts.length > 0
    ? { status: "conflict", files: conflicts.sort() }
    : { status: "clean", files: merged };
}

export class FakeQueueJobs implements QueueJobs {
  readonly calls: Array<{ op: string; input: unknown }> = [];
  /** Throw from the next `n` jobs (infrastructure failures). */
  failNext = 0;
  /** Replace the analyzer (e.g. to put Changes on one track through a shared module). */
  affectedOverride: ((input: { files: string[]; headSha: string }) => unknown) | null = null;
  /** Resolution patches are JSON `{ files: { path: content | null } }` in this fake. */
  constructor(private readonly git: FakeGitHost) {}

  private guard(op: string, input: unknown): void {
    this.calls.push({ op, input });
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(`fake ${op} job failed`);
    }
  }

  async ensureScratch(input: { mainRepo: string; scratch: string }): Promise<void> {
    this.calls.push({ op: "ensureScratch", input });
    await this.git.forkRepo(input.mainRepo, input.scratch);
  }

  private replay(scratch: string, e: ReplaySpec, onto: string) {
    const g = this.git;
    g.copyObjects(scratch, e.headSha);
    const out = mergeFiles(g.filesAt(e.replayBase), g.filesAt(e.headSha), g.filesAt(onto));
    if (out.status === "conflict") return { ...out, sha: null };
    const repo = g.repo(scratch);
    const tmp = `refs/gittifacts/mq/tmp-${e.changeId}`;
    repo.refs.set(`refs/heads/${tmp}`, onto);
    const changes: Record<string, string | null> = {};
    const before = g.filesAt(onto);
    for (const p of new Set([...Object.keys(before), ...Object.keys(out.files)]))
      if (before[p] !== out.files[p]) changes[p] = out.files[p] ?? null;
    const sha = g.commit(scratch, tmp, changes, `${e.changeId} (replayed)`);
    repo.refs.delete(`refs/heads/${tmp}`);
    return { status: "clean" as const, files: [], sha };
  }

  /** Commits in `from..to` (first parent) that touched any of `paths`. */
  private touching(from: string, to: string, paths: string[]): string[] {
    const g = this.git;
    const stop = new Set(g.ancestry(from));
    const out: string[] = [];
    for (const sha of g.ancestry(to)) {
      if (stop.has(sha)) break;
      const parent = g.commits.get(sha)?.parents[0];
      if (parent === undefined) break;
      const a = g.filesAt(parent);
      const b = g.filesAt(sha);
      if (paths.some((p) => a[p] !== b[p])) out.push(sha);
    }
    return out;
  }

  async buildBatch(input: {
    scratch: string;
    baseRepo: string;
    baseSha: string;
    entries: ReplaySpec[];
    ref: string;
  }) {
    this.guard("buildBatch", input);
    const g = this.git;
    g.copyObjects(input.scratch, input.baseSha);
    let tip = input.baseSha;
    const commits: { changeId: string; commitSha: string; treeSha: string }[] = [];
    for (const e of input.entries) {
      const r = this.replay(input.scratch, e, tip);
      if (r.sha === null) {
        return {
          status: "conflict" as const,
          changeId: e.changeId,
          files: r.files,
          upstreamCommits: this.touching(e.replayBase, tip, r.files),
        };
      }
      tip = r.sha;
      commits.push({
        changeId: e.changeId,
        commitSha: tip,
        treeSha: g.commits.get(tip)?.tree ?? "",
      });
    }
    g.repo(input.scratch).refs.set(input.ref, tip);
    const last = commits[commits.length - 1];
    return {
      status: "clean" as const,
      tipSha: tip,
      treeSha: last?.treeSha ?? "",
      commits,
    };
  }

  async affected(input: { repo: string; baseSha: string; headSha: string }): Promise<unknown> {
    this.guard("affected", input);
    const g = this.git;
    const a = g.filesAt(input.baseSha);
    const b = g.filesAt(input.headSha);
    const files = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((p) => a[p] !== b[p])
      .sort();
    const tests = new Set<string>();
    for (const f of files) {
      if (/\.test\.[jt]s$/.test(f)) tests.add(f);
      const sibling = f.replace(/\.([jt]s)$/, ".test.$1");
      if (sibling !== f && b[sibling] !== undefined) tests.add(sibling);
    }
    if (this.affectedOverride !== null)
      return this.affectedOverride({ files, headSha: input.headSha });
    return {
      files,
      modules: files.filter((f) => !/\.test\.[jt]s$/.test(f)),
      testTargets: [...tests].sort(),
      publicApi: false,
      deploysTo: [],
      complete: true,
      analyzers: [{ name: "fake", version: "1", complete: true }],
    };
  }

  async mergeAttempt(input: {
    scratch: string;
    baseRepo: string;
    ontoSha: string;
    preceding: ReplaySpec[];
    change: ReplaySpec;
    ref: string;
  }): Promise<{ ontoSha: string; doc: unknown }> {
    this.guard("mergeAttempt", input);
    const g = this.git;
    g.copyObjects(input.scratch, input.ontoSha);
    let onto = input.ontoSha;
    for (const p of input.preceding) {
      const r = this.replay(input.scratch, p, onto);
      if (r.sha === null) throw new Error(`preceding ${p.changeId} conflicts`);
      onto = r.sha;
    }
    const e = input.change;
    const r = this.replay(input.scratch, e, onto);
    const markers = { size: 13, ours: "upstream", base: "base", theirs: "change" };
    if (r.sha !== null)
      return {
        ontoSha: onto,
        doc: {
          status: "clean",
          base: e.replayBase,
          onto,
          head: e.headSha,
          newSha: r.sha,
          files: [],
          markers,
        },
      };
    const [base, ours, theirs] = [g.filesAt(e.replayBase), g.filesAt(onto), g.filesAt(e.headSha)];
    const marked = (path: string) =>
      `<<<<<<<<<<<<< upstream\n${ours[path] ?? ""}=============\n${theirs[path] ?? ""}>>>>>>>>>>>>> change\n`;
    const files = r.files.map((path) => ({
      path,
      kind: "content",
      mode: "100644",
      binary: false,
      tooLarge: false,
      base: base[path] ?? null,
      ours: ours[path] ?? null,
      theirs: theirs[path] ?? null,
      merged_with_markers: marked(path),
    }));
    // The conflict commit: onto + the Change's clean edits + the conflicted files with markers.
    const changes: Record<string, string | null> = {};
    for (const path of new Set([...Object.keys(base), ...Object.keys(theirs)])) {
      if (base[path] === theirs[path]) continue;
      changes[path] = r.files.includes(path) ? marked(path) : (theirs[path] ?? null);
    }
    const repo = g.repo(input.scratch);
    const tmp = "refs/gittifacts/mq/tmp-conflict";
    repo.refs.set(`refs/heads/${tmp}`, onto);
    const conflictSha = g.commit(input.scratch, tmp, changes, `${e.changeId} (conflicted)`);
    repo.refs.delete(`refs/heads/${tmp}`);
    repo.refs.set(input.ref, conflictSha);
    return {
      ontoSha: onto,
      doc: {
        status: "conflict",
        base: e.replayBase,
        onto,
        head: e.headSha,
        conflictSha,
        files,
        markers,
      },
    };
  }

  async applyResolution(input: { scratch: string; patch: string; onto: string; ref: string }) {
    this.guard("applyResolution", input);
    const g = this.git;
    const parsed = JSON.parse(input.patch) as { files: Record<string, string | null> };
    const repo = g.repo(input.scratch);
    const tmp = "refs/gittifacts/mq/tmp-resolution";
    repo.refs.set(`refs/heads/${tmp}`, input.onto);
    const sha = g.commit(input.scratch, tmp, parsed.files, "resolution by gittifacts-resolver");
    repo.refs.delete(`refs/heads/${tmp}`);
    repo.refs.set(input.ref, sha);
    return {
      status: "resolved",
      parentSha: input.onto,
      newSha: sha,
      files: Object.keys(parsed.files),
    };
  }
}
