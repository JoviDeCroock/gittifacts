/**
 * In-memory GitHost. Commits hold flat file maps; tree shas are content-addressed (so tree
 * equality means content equality, which pure-revert verification relies on); each repo tracks
 * which objects it has, so `updateRef` to an untransferred commit fails like Artifacts does.
 */
import type { ChangeDiff, ChangeDiffFile } from "@app/domain";
import { diffText } from "../adapters/line-diff.js";
import { buildChangeDiff } from "../adapters/tree-diff.js";
import { isForkName, ZERO_SHA } from "../ids.js";
import type { FastForwardResult, GitHost } from "../ports.js";

export interface FakeCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
}

export interface FakeRepo {
  name: string;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Set<string>;
  /** notesRef → target sha → note */
  notes: Map<string, Map<string, string>>;
}

export type Files = Readonly<Record<string, string>>;

/** Deterministic 40-hex digest (FNV-1a lanes); good enough to be unique in tests. */
export function hex40(input: string): string {
  let out = "";
  for (let lane = 0; lane < 5; lane++) {
    let h = (0x811c9dc5 ^ (lane * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

export class FakeGitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export class FakeGitHost implements GitHost {
  readonly namespace: string;
  readonly repos = new Map<string, FakeRepo>();
  readonly commits = new Map<string, FakeCommit>();
  readonly trees = new Map<string, Files>();
  readonly tokens: Array<{
    repo: string;
    scope: "read" | "write";
    ttlSeconds: number;
    token: string;
    /** Import grants (mintImportToken) carry an id and can be revoked. */
    id?: string;
    revoked?: boolean;
  }> = [];
  /** Make revokeToken report failure (a revocation the host could not confirm). */
  revokeFails = false;
  /** Every write: op + repo (+ ref). */
  readonly writes: Array<{ op: string; repo: string; ref?: string }> = [];
  readonly deleted: string[] = [];
  /** url → files, for importRepo. */
  readonly importSources = new Map<string, { files: Files; defaultBranch?: string }>();
  /** Write guard, like ArtifactsGitHost's (default: anything). */
  canWrite: (repo: string) => boolean = () => true;
  /** Return a result to short-circuit an updateRef (e.g. one injected stale). */
  updateRefHook:
    | ((repo: string, ref: string, oldSha: string, newSha: string) => FastForwardResult | undefined)
    | null = null;
  private counter = 0;
  private tokenCounter = 0;

  constructor(opts: { namespace?: string } = {}) {
    this.namespace = opts.namespace ?? "fake-eu";
  }

  // ------------------------------------------------------------ test helpers

  treeSha(files: Files): string {
    const entries = Object.keys(files)
      .sort()
      .map((k) => [k, files[k]]);
    const sha = hex40(`tree\u0000${JSON.stringify(entries)}`);
    if (!this.trees.has(sha)) this.trees.set(sha, { ...files });
    return sha;
  }

  private newCommit(tree: string, parents: string[], message: string): string {
    const sha = hex40(
      `commit\u0000${++this.counter}\u0000${tree}\u0000${parents.join(",")}\u0000${message}`,
    );
    this.commits.set(sha, { sha, tree, parents, message });
    return sha;
  }

  repo(name: string): FakeRepo {
    const r = this.repos.get(name);
    if (r === undefined) throw new FakeGitError("NOT_FOUND", `repo ${name}`);
    return r;
  }

  /** Create `name` with one commit holding `files`. Returns the commit sha. */
  seed(
    name: string,
    files: Files,
    opts: { defaultBranch?: string; message?: string } = {},
  ): string {
    const branch = opts.defaultBranch ?? "main";
    if (!this.repos.has(name)) {
      this.repos.set(name, {
        name,
        defaultBranch: branch,
        refs: new Map(),
        objects: new Set(),
        notes: new Map(),
      });
    }
    const sha = this.newCommit(this.treeSha(files), [], opts.message ?? "initial commit");
    const repo = this.repo(name);
    repo.objects.add(sha);
    repo.refs.set(`refs/heads/${branch}`, sha);
    return sha;
  }

  /** A push: commit `changes` (null deletes a path) on top of `branch` in `repo`. */
  commit(
    repoName: string,
    branch: string,
    changes: Record<string, string | null>,
    message = "change",
  ): string {
    const repo = this.repo(repoName);
    const parent = repo.refs.get(`refs/heads/${branch}`) ?? null;
    const files: Record<string, string> = parent === null ? {} : { ...this.filesAt(parent) };
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) delete files[path];
      else files[path] = content;
    }
    const sha = this.newCommit(this.treeSha(files), parent === null ? [] : [parent], message);
    repo.objects.add(sha);
    repo.refs.set(`refs/heads/${branch}`, sha);
    return sha;
  }

  filesAt(sha: string): Files {
    const c = this.commits.get(sha);
    if (c === undefined) throw new FakeGitError("NOT_FOUND", `commit ${sha}`);
    return this.trees.get(c.tree) ?? {};
  }

  head(repo: string, branch?: string): string | null {
    const r = this.repo(repo);
    return r.refs.get(`refs/heads/${branch ?? r.defaultBranch}`) ?? null;
  }

  /** First-parent ancestors of `sha` (inclusive), newest first. */
  ancestry(sha: string): string[] {
    const out: string[] = [];
    let cur: string | undefined = sha;
    while (cur !== undefined) {
      out.push(cur);
      cur = this.commits.get(cur)?.parents[0];
    }
    return out;
  }

  /** Every commit reachable from `sha`. */
  reachable(sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      const s = stack.pop();
      if (s === undefined || seen.has(s)) continue;
      seen.add(s);
      for (const p of this.commits.get(s)?.parents ?? []) stack.push(p);
    }
    return seen;
  }

  /** Copy every object reachable from `sha` into `repo` (what a fetch would do). */
  copyObjects(repo: string, sha: string): void {
    const r = this.repo(repo);
    for (const s of this.reachable(sha)) r.objects.add(s);
  }

  private guard(repo: string, op: string): void {
    if (!this.canWrite(repo)) throw new FakeGitError("FORBIDDEN", `${op} on ${repo}`);
  }

  // ------------------------------------------------------------ GitHost

  remoteOf(name: string): string {
    return `https://fake.artifacts.test/git/${this.namespace}/${name}.git`;
  }

  async createRepo(name: string, opts: { defaultBranch: string }): Promise<{ remote: string }> {
    if (this.repos.has(name)) throw new FakeGitError("ALREADY_EXISTS", name);
    this.repos.set(name, {
      name,
      defaultBranch: opts.defaultBranch,
      refs: new Map(),
      objects: new Set(),
      notes: new Map(),
    });
    return { remote: this.remoteOf(name) };
  }

  async importRepo(
    name: string,
    url: string,
    opts: { branch?: string } = {},
  ): Promise<{ remote: string; defaultBranch: string }> {
    const source = this.importSources.get(url);
    if (source === undefined) throw new FakeGitError("REMOTE_AUTH_REQUIRED", url);
    const defaultBranch = opts.branch ?? source.defaultBranch ?? "main";
    this.seed(name, source.files, { defaultBranch, message: `import ${url}` });
    return { remote: this.remoteOf(name), defaultBranch };
  }

  async forkRepo(source: string, target: string): Promise<{ remote: string }> {
    if (this.repos.has(target)) return { remote: this.remoteOf(target) }; // idempotent
    const src = this.repo(source);
    const branchRef = `refs/heads/${src.defaultBranch}`;
    const tip = src.refs.get(branchRef);
    this.repos.set(target, {
      name: target,
      defaultBranch: src.defaultBranch,
      refs: new Map(tip === undefined ? [] : [[branchRef, tip]]),
      objects: new Set(src.objects),
      notes: new Map(),
    });
    return { remote: this.remoteOf(target) };
  }

  async deleteRepo(name: string): Promise<void> {
    this.guard(name, "delete");
    this.repos.delete(name);
    this.deleted.push(name);
  }

  async mintToken(
    repo: string,
    scope: "read" | "write",
    ttlSeconds: number,
  ): Promise<{ token: string; expiresAt: string }> {
    this.repo(repo);
    if (scope === "write") this.guard(repo, "mint write token");
    const capped =
      scope === "write" ? Math.min(ttlSeconds, isForkName(repo) ? 3600 : 300) : ttlSeconds;
    const token = `fake_${scope}_${repo}_${++this.tokenCounter}`;
    this.tokens.push({ repo, scope, ttlSeconds: capped, token });
    return { token, expiresAt: new Date(Date.UTC(2030, 0, 1) + capped * 1000).toISOString() };
  }

  /** Like ArtifactsGitHost: any role, main repos only, and only before `branch` exists. */
  async mintImportToken(
    repo: string,
    input: { branch: string; ttlSeconds: number },
  ): Promise<{ token: string; tokenId: string; expiresAt: string }> {
    const r = this.repo(repo);
    if (isForkName(repo)) throw new FakeGitError("FORBIDDEN", `import grant on fork ${repo}`);
    if (r.refs.has(`refs/heads/${input.branch}`)) {
      throw new FakeGitError("FORBIDDEN", `${repo} already has ${input.branch}`);
    }
    const ttlSeconds = Math.min(Math.max(60, input.ttlSeconds), 1800);
    const n = ++this.tokenCounter;
    const token = `fake_import_${repo}_${n}`;
    const id = `imp${n.toString().padStart(13, "0")}`;
    this.tokens.push({ repo, scope: "write", ttlSeconds, token, id, revoked: false });
    return {
      token,
      tokenId: id,
      expiresAt: new Date(Date.UTC(2030, 0, 1) + ttlSeconds * 1000).toISOString(),
    };
  }

  async revokeToken(repo: string, tokenId: string): Promise<boolean> {
    if (this.revokeFails) return false;
    const t = this.tokens.find((x) => x.repo === repo && x.id === tokenId);
    if (t === undefined) return false;
    t.revoked = true;
    return true;
  }

  async branchHead(repo: string, branch: string): Promise<string | null> {
    return this.repo(repo).refs.get(`refs/heads/${branch}`) ?? null;
  }

  async commitParents(repo: string, sha: string): Promise<string[] | null> {
    if (!this.repo(repo).objects.has(sha)) return null;
    return [...(this.commits.get(sha)?.parents ?? [])];
  }

  async commitMessage(repo: string, sha: string): Promise<string | null> {
    if (!this.repo(repo).objects.has(sha)) return null;
    return this.commits.get(sha)?.message ?? null;
  }

  async treeOf(repo: string, sha: string): Promise<string | null> {
    if (!this.repo(repo).objects.has(sha)) return null;
    return this.commits.get(sha)?.tree ?? null;
  }

  async readFile(repo: string, ref: string, path: string): Promise<Uint8Array | null> {
    const r = this.repo(repo);
    const sha =
      r.refs.get(ref) ?? r.refs.get(`refs/heads/${ref}`) ?? (r.objects.has(ref) ? ref : undefined);
    if (sha === undefined) return null;
    const content = this.filesAt(sha)[path];
    return content === undefined ? null : new TextEncoder().encode(content);
  }

  async diff(repo: string, baseSha: string, headSha: string): Promise<ChangeDiff> {
    const r = this.repo(repo);
    for (const s of [baseSha, headSha])
      if (!r.objects.has(s)) throw new FakeGitError("NOT_FOUND", `commit ${s} in ${repo}`);
    return diffFiles(baseSha, headSha, this.filesAt(baseSha), this.filesAt(headSha));
  }

  async readNote(
    repo: string,
    targetSha: string,
    notesRef = "refs/notes/evidence",
  ): Promise<string | null> {
    return this.repo(repo).notes.get(notesRef)?.get(targetSha) ?? null;
  }

  async writeNote(
    repo: string,
    targetSha: string,
    content: string,
    opts: { notesRef?: string; mode?: "replace" | "append" } = {},
  ): Promise<void> {
    this.guard(repo, "write note");
    const r = this.repo(repo);
    const ref = opts.notesRef ?? "refs/notes/evidence";
    const notes = r.notes.get(ref) ?? new Map<string, string>();
    const old = notes.get(targetSha);
    notes.set(targetSha, opts.mode === "append" && old ? `${old}\n${content}` : content);
    r.notes.set(ref, notes);
    this.writes.push({ op: "note", repo, ref });
  }

  async transferObjects(
    fromRepo: string,
    toRepo: string,
    sha: string,
    toRef: string,
  ): Promise<void> {
    this.guard(toRepo, "transfer");
    if (!this.repo(fromRepo).objects.has(sha))
      throw new FakeGitError("NOT_FOUND", `${sha} in ${fromRepo}`);
    this.copyObjects(toRepo, sha);
    this.repo(toRepo).refs.set(toRef, sha);
    this.writes.push({ op: "transfer", repo: toRepo, ref: toRef });
  }

  /**
   * GitHub mode: `source.url` names another repo of this fake (the "GitHub" side, e.g.
   * `https://github.com/acme/app.git` → repo `github.com/acme/app`); the fetch copies objects.
   */
  readonly externalFetches: Array<{
    url: string;
    toRepo: string;
    sha: string;
    toRef: string;
    authed: boolean;
  }> = [];
  async fetchExternal(
    source: { url: string; auth?: { basic: { username: string; password: string } } },
    toRepo: string,
    input: { sha: string; toRef: string },
  ): Promise<void> {
    this.guard(toRepo, "fetch external");
    const from = source.url.replace(/^https:\/\//, "").replace(/\.git$/, "");
    if (!this.repo(from).objects.has(input.sha)) {
      throw new FakeGitError("NOT_FOUND", `${input.sha} in ${from}`);
    }
    this.copyObjects(toRepo, input.sha);
    this.repo(toRepo).refs.set(input.toRef, input.sha);
    this.externalFetches.push({
      url: source.url,
      toRepo,
      ...input,
      authed: source.auth !== undefined,
    });
    this.writes.push({ op: "fetch-external", repo: toRepo, ref: input.toRef });
  }

  async updateRef(
    repo: string,
    ref: string,
    oldSha: string,
    newSha: string,
  ): Promise<FastForwardResult> {
    this.guard(repo, "update ref");
    const hooked = this.updateRefHook?.(repo, ref, oldSha, newSha);
    if (hooked !== undefined) return hooked;
    const r = this.repo(repo);
    const current = r.refs.get(ref) ?? ZERO_SHA;
    if (current !== oldSha)
      return {
        ok: false,
        reason: "stale",
        detail: `ng ${ref} stale ref (is ${current.slice(0, 12)})`,
      };
    if (newSha !== ZERO_SHA && !r.objects.has(newSha))
      return { ok: false, reason: "missing-object", detail: `ng ${ref} missing object` };
    if (newSha === ZERO_SHA) r.refs.delete(ref);
    else r.refs.set(ref, newSha);
    this.writes.push({ op: "update-ref", repo, ref });
    return { ok: true };
  }

  async writeInitialCommit(
    repo: string,
    input: {
      branch: string;
      files: Readonly<Record<string, string | Uint8Array>>;
      message: string;
    },
  ): Promise<{ sha: string; treeSha: string }> {
    // Create-only, like the real host: no write guard, but never over an existing branch.
    const r = this.repo(repo);
    const ref = `refs/heads/${input.branch}`;
    if (r.refs.has(ref)) throw new FakeGitError("STALE", `${ref} already exists in ${repo}`);
    if (Object.keys(input.files).length === 0) throw new TypeError("an initial commit needs files");
    const decoder = new TextDecoder();
    const files: Record<string, string> = {};
    for (const [path, content] of Object.entries(input.files)) {
      files[path] = typeof content === "string" ? content : decoder.decode(content);
    }
    const treeSha = this.treeSha(files);
    const sha = this.newCommit(treeSha, [], input.message);
    r.objects.add(sha);
    r.refs.set(ref, sha);
    this.writes.push({ op: "initial-commit", repo, ref });
    return { sha, treeSha };
  }

  async commitTree(
    repo: string,
    input: {
      treeSha: string;
      parents: string[];
      message: string;
      branch: string;
      expectedOld: string;
    },
  ): Promise<{ sha: string }> {
    this.guard(repo, "commit");
    const r = this.repo(repo);
    const ref = `refs/heads/${input.branch}`;
    if ((r.refs.get(ref) ?? ZERO_SHA) !== input.expectedOld)
      throw new FakeGitError("STALE", `${ref} moved`);
    if (!this.trees.has(input.treeSha))
      throw new FakeGitError("NOT_FOUND", `tree ${input.treeSha}`);
    const sha = this.newCommit(input.treeSha, input.parents, input.message);
    r.objects.add(sha);
    r.refs.set(ref, sha);
    this.writes.push({ op: "commit", repo, ref });
    return { sha };
  }
}

/** Diff two flat file maps (exact renames by content). */
export function diffFiles(baseSha: string, headSha: string, base: Files, head: Files): ChangeDiff {
  const files: ChangeDiffFile[] = [];
  const added = Object.keys(head).filter((p) => !(p in base));
  const deleted = Object.keys(base).filter((p) => !(p in head));
  const renamedFrom = new Map<string, string>();
  for (const d of deleted) {
    const target = added.find((a) => head[a] === base[d] && !renamedFrom.has(a));
    if (target !== undefined) renamedFrom.set(target, d);
  }
  const consumed = new Set(renamedFrom.values());
  const paths = new Set([...Object.keys(base), ...Object.keys(head)]);
  for (const path of [...paths].sort()) {
    if (consumed.has(path)) continue;
    const before = base[path];
    const after = head[path];
    if (before === after) continue;
    const from = renamedFrom.get(path);
    if (from !== undefined) {
      files.push({
        path,
        previousPath: from,
        status: "renamed",
        additions: 0,
        deletions: 0,
        binary: false,
        transformVerified: false,
        hunks: [],
        truncated: false,
      });
      continue;
    }
    const d = diffText(before ?? "", after ?? "");
    files.push({
      path,
      previousPath: null,
      status: before === undefined ? "added" : after === undefined ? "deleted" : "modified",
      additions: d.additions,
      deletions: d.deletions,
      binary: false,
      transformVerified: false,
      hunks: d.hunks,
      truncated: false,
    });
  }
  return buildChangeDiff(baseSha, headSha, files);
}
