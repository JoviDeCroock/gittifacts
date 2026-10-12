/**
 * `GitHost` on Cloudflare Artifacts: the Workers binding for the control plane and reads
 * (create/import/fork/delete, tokens, readCommit/readTree/readBlob/readFile/log), and
 * `@app/gitwire` over smart HTTP for every write (notes, object transfer, CAS ref updates,
 * commits), since Artifacts has no write API (docs/research/artifacts.md §2, §12).
 *
 * gitwire is injected (`wire: await import("@app/gitwire")` or `import * as gitwire`) through the
 * structural `GitWire` interface, so this package does not type-check gitwire's sources.
 *
 * Write guard: by default this host refuses to write anywhere but change forks (`task-*`). The
 * MergeQueue's Ports get a host built with `canWrite: () => true`; that is the only way main-repo
 * write tokens get minted, internally, with TTL ≤ 300 s, and they are never returned.
 */
import type { ChangeDiff } from "@app/domain";
import { isForkName } from "../ids.js";
import type { FastForwardResult, GitCommitInfo, GitHost, GitPath, GitTreeItem } from "../ports.js";
import { diffTrees, type TreeReader } from "./tree-diff.js";

/** gitwire's remote shape. */
export interface WireRemote {
  url: string;
  auth?: { bearer: string } | { basic: { username: string; password: string } };
  fetch?: typeof fetch;
}

export interface WireObject {
  type: "blob" | "tree" | "commit" | "tag";
  data: Uint8Array;
}

export interface WireRefResult {
  ref: string;
  ok: boolean;
  reason?: string;
}

export interface WirePushReport {
  unpackOk: boolean;
  unpackError?: string;
  refs: WireRefResult[];
}

/**
 * The slice of `@app/gitwire` this adapter uses (pass the module itself). Errors are told apart
 * by `name` ("StaleRefError", "MissingObjectError", "RejectedError").
 */
export interface GitWire {
  readNote(source: WireRemote, notesRef: string, targetSha: string): Promise<string | null>;
  writeNote(
    remote: WireRemote,
    opts: {
      notesRef?: string;
      targetSha: string;
      content: string;
      author: { name: string; email: string };
      mode?: "replace" | "append";
    },
  ): Promise<unknown>;
  transferObjects(
    from: WireRemote,
    to: WireRemote,
    opts: { sha: string; toRef: string; oldSha?: string; haves?: string[] },
  ): Promise<WireRefResult>;
  fastForward(
    remote: WireRemote,
    ref: string,
    oldSha: string,
    newSha: string,
  ): Promise<WireRefResult>;
  receivePack(
    remote: WireRemote,
    updates: Array<{ ref: string; oldSha: string; newSha: string }>,
    pack?: Uint8Array,
  ): Promise<WirePushReport>;
  assertRefUpdated(report: WirePushReport, ref: string): WireRefResult;
  encodeTree(entries: ReadonlyArray<{ mode: string; name: string; sha: string }>): Uint8Array;
  encodeCommit(c: {
    tree: string;
    parents: string[];
    author: { name: string; email: string; timestamp: number; timezone: string };
    committer: { name: string; email: string; timestamp: number; timezone: string };
    message: string;
  }): Uint8Array;
  hashObject(obj: WireObject): Promise<string>;
  buildPack(objects: readonly WireObject[]): Promise<Uint8Array>;
  /** Advertised refs (ref → sha); an empty repo advertises none. */
  listRefs(remote: WireRemote): Promise<ReadonlyMap<string, string>>;
}

/** Structural slice of the Artifacts repo handle (`ArtifactsRepo` satisfies it). */
export interface ArtifactsRepoLike {
  createToken(
    scope?: "write" | "read",
    ttl?: number,
  ): Promise<{ id?: string; plaintext: string; expiresAt: string }>;
  /** True when the token (plaintext or id) was revoked. */
  revokeToken?(tokenOrId: string): Promise<boolean>;
  info(): Promise<{ defaultBranch: string; remote: string }>;
  readBlob(hash: string): Promise<Blob | null>;
  readTree(hash: string): Promise<Array<{
    name: string;
    mode: string;
    hash: string;
    type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
  }> | null>;
  readCommit(hash: string): Promise<ArtifactsCommitLike | null>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
  /** First-parent chain, newest first; [] for an unknown ref. Fake repos may omit the metadata. */
  log(opts?: {
    ref?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<Partial<ArtifactsCommitLike> & { hash: string }>>;
  fork(
    name: string,
    opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
  ): Promise<{ remote: string }>;
}

/** `ArtifactsCommitMetadata` (docs/research/artifacts.md §2); the people and times may be absent in fakes. */
export interface ArtifactsCommitLike {
  hash: string;
  treeHash: string;
  parents: string[];
  message?: string;
  author?: { name: string; email: string };
  committer?: { name: string; email: string };
  /** Seconds since the epoch. */
  authoredAt?: number;
  committedAt?: number;
}

/** Structural slice of the `Artifacts` binding. */
export interface ArtifactsBindingLike {
  create(
    name: string,
    opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
  ): Promise<{ remote: string; defaultBranch: string }>;
  get(name: string): Promise<ArtifactsRepoLike>;
  import(params: {
    source: { url: string; branch?: string; depth?: number };
    target: { name: string; opts?: { description?: string; readOnly?: boolean } };
  }): Promise<{ remote: string; defaultBranch: string }>;
  delete(name: string): Promise<boolean>;
}

export interface ArtifactsGitHostOptions {
  binding: ArtifactsBindingLike;
  /** `@app/gitwire` (the module namespace object). */
  wire: GitWire;
  namespace: string;
  accountId: string;
  /** Repos this host may write to. Default: change forks only. */
  canWrite?: (repo: string) => boolean;
  /** fetch for gitwire (tests, service bindings). */
  fetch?: typeof fetch;
  committer?: { name: string; email: string };
  /** Polling for *_IN_PROGRESS after import/fork. */
  pollIntervalMs?: number;
  pollAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Fork push tokens (agents) may live an hour; main-repo write tokens at most five minutes. */
export const MAX_FORK_TOKEN_TTL = 3600;
export const MAX_MAIN_WRITE_TOKEN_TTL = 300;
/** Import-by-push grants (a human owner's initial push to an empty repo): at most 30 minutes. */
export const MAX_IMPORT_TOKEN_TTL = 1800;
const INTERNAL_TOKEN_TTL = 300;

export class GitWriteForbiddenError extends Error {
  override name = "GitWriteForbiddenError";
}

const ZERO = "0".repeat(40);
const encoder = new TextEncoder();
/** Where `forkRepo` keeps a fork's own copy of its inherited history (see `hydrateFork`). */
export const FORK_OBJECTS_REF = "refs/gittifacts/fork-objects";

/** A safe repository path: relative, no `.`/`..`/empty segments, never inside `.git`. */
export function assertRepoPath(path: string): string[] {
  const parts = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\0")) ||
    parts.some((p) => p.toLowerCase() === ".git")
  ) {
    throw new TypeError(`invalid repository path ${JSON.stringify(path)}`);
  }
  return parts;
}

interface DirNode {
  files: Map<string, Uint8Array>;
  dirs: Map<string, DirNode>;
}

/** Nested directory nodes for a flat `path → content` map. */
export function fileTree(files: Readonly<Record<string, string | Uint8Array>>): DirNode {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, content] of Object.entries(files)) {
    const parts = assertRepoPath(path);
    const name = parts.pop() as string;
    let dir = root;
    for (const part of parts) {
      if (dir.files.has(part))
        throw new TypeError(`${path}: ${part} is both a file and a directory`);
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    if (dir.dirs.has(name)) throw new TypeError(`${path} is both a file and a directory`);
    dir.files.set(name, typeof content === "string" ? encoder.encode(content) : content);
  }
  return root;
}

function errorCode(e: unknown): string | null {
  if (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof (e as { code: unknown }).code === "string"
  ) {
    return (e as { code: string }).code;
  }
  const m =
    e instanceof Error ? /\b(ALREADY_EXISTS|NOT_FOUND|[A-Z]+_IN_PROGRESS)\b/.exec(e.message) : null;
  return m?.[1] ?? null;
}

function refErrorReason(e: unknown): string {
  if (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { reason?: unknown }).reason === "string"
  ) {
    return (e as { reason: string }).reason;
  }
  return e instanceof Error ? e.message : String(e);
}

function dispose(handle: unknown): void {
  const sym = (Symbol as unknown as { dispose?: symbol }).dispose;
  if (sym === undefined || typeof handle !== "object" || handle === null) return;
  const fn = (handle as Record<symbol, unknown>)[sym];
  if (typeof fn === "function") (fn as () => void).call(handle);
}

function commitInfo(c: ArtifactsCommitLike): GitCommitInfo {
  const author = c.author ?? { name: "", email: "" };
  const committer = c.committer ?? author;
  return {
    sha: c.hash,
    tree: c.treeHash,
    parents: [...c.parents],
    message: c.message ?? "",
    author: { ...author, at: c.authoredAt ?? 0 },
    committer: { ...committer, at: c.committedAt ?? c.authoredAt ?? 0 },
  };
}

export class ArtifactsGitHost implements GitHost {
  readonly namespace: string;
  private readonly canWrite: (repo: string) => boolean;
  private readonly committer: { name: string; email: string };
  private readonly tokens = new Map<string, { token: string; until: number }>();

  constructor(private readonly opts: ArtifactsGitHostOptions) {
    this.namespace = opts.namespace;
    this.canWrite = opts.canWrite ?? isForkName;
    this.committer = opts.committer ?? { name: "gittifacts", email: "bot@gittifacts.dev" };
  }

  // ------------------------------------------------------------ helpers

  private async withRepo<T>(name: string, fn: (repo: ArtifactsRepoLike) => Promise<T>): Promise<T> {
    const repo = await this.opts.binding.get(name);
    try {
      return await fn(repo);
    } finally {
      dispose(repo);
    }
  }

  private guardWrite(repo: string): void {
    if (!this.canWrite(repo)) {
      throw new GitWriteForbiddenError(
        `this GitHost may not write to ${repo} (only the merge queue writes main repos)`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** Wait until `get(name)` stops throwing *_IN_PROGRESS. */
  private async waitReady(name: string): Promise<{ defaultBranch: string; remote: string }> {
    const attempts = this.opts.pollAttempts ?? 60;
    for (let i = 0; ; i++) {
      try {
        return await this.withRepo(name, (r) => r.info());
      } catch (e) {
        const code = errorCode(e);
        if (code === null || !code.endsWith("_IN_PROGRESS") || i >= attempts) throw e;
        await this.sleep(this.opts.pollIntervalMs ?? 2000);
      }
    }
  }

  /** Short-lived internal token (cached until 30 s before expiry). Never leaves this object. */
  private async internalToken(repo: string, scope: "read" | "write"): Promise<string> {
    if (scope === "write") this.guardWrite(repo);
    const key = `${scope}:${repo}`;
    const cached = this.tokens.get(key);
    if (cached !== undefined && cached.until > Date.now()) return cached.token;
    const { plaintext } = await this.withRepo(repo, (r) =>
      r.createToken(scope, INTERNAL_TOKEN_TTL),
    );
    this.tokens.set(key, {
      token: plaintext,
      until: Date.now() + (INTERNAL_TOKEN_TTL - 30) * 1000,
    });
    return plaintext;
  }

  private async remote(
    repo: string,
    scope: "read" | "write",
    opts: { createOnly?: boolean } = {},
  ): Promise<WireRemote> {
    const token =
      opts.createOnly === true
        ? // Repo creation: a write token for this one push, which may only create the branch.
          (await this.withRepo(repo, (r) => r.createToken("write", INTERNAL_TOKEN_TTL))).plaintext
        : await this.internalToken(repo, scope);
    const remote: WireRemote = { url: this.remoteOf(repo), auth: { bearer: token } };
    if (this.opts.fetch) remote.fetch = this.opts.fetch;
    return remote;
  }

  // ------------------------------------------------------------ control plane

  remoteOf(name: string): string {
    return `https://${this.opts.accountId}.artifacts.cloudflare.net/git/${this.namespace}/${name}.git`;
  }

  async createRepo(
    name: string,
    opts: { defaultBranch: string; description?: string },
  ): Promise<{ remote: string }> {
    const created = await this.opts.binding.create(name, {
      setDefaultBranch: opts.defaultBranch,
      ...(opts.description === undefined ? {} : { description: opts.description }),
    });
    return { remote: created.remote };
  }

  async importRepo(
    name: string,
    url: string,
    opts: { branch?: string } = {},
  ): Promise<{ remote: string; defaultBranch: string }> {
    try {
      await this.opts.binding.import({
        source: { url, ...(opts.branch === undefined ? {} : { branch: opts.branch }) },
        target: { name },
      });
    } catch (e) {
      if (errorCode(e) !== "IMPORT_IN_PROGRESS") throw e;
    }
    const info = await this.waitReady(name);
    return { remote: info.remote, defaultBranch: info.defaultBranch };
  }

  async forkRepo(
    source: string,
    target: string,
    opts: { readOnly?: boolean } = {},
  ): Promise<{ remote: string }> {
    await this.startFork(source, target, opts);
    let info: { defaultBranch: string; remote: string };
    try {
      info = await this.waitReady(target);
    } catch (e) {
      if (errorCode(e) !== "FORK_IN_PROGRESS") throw e;
      // Still "being forked" after the whole wait: the fork is stuck and never completes (seen live
      // 2026-10-03: a revert's fork, requested as the platform was redeployed, was still in progress
      // 40 minutes later, so the revert was never opened). A stuck fork can be deleted: fork again.
      await this.deleteRepo(target);
      await this.startFork(source, target, opts);
      info = await this.waitReady(target);
    }
    await this.hydrateFork(source, target, info.defaultBranch);
    return { remote: info.remote };
  }

  private async startFork(
    source: string,
    target: string,
    opts: { readOnly?: boolean },
  ): Promise<void> {
    try {
      await this.withRepo(source, (r) =>
        r.fork(target, {
          defaultBranchOnly: true,
          ...(opts.readOnly === undefined ? {} : { readOnly: opts.readOnly }),
        }),
      );
    } catch (e) {
      // Idempotent: a retried fork finds its target already there (or still being created).
      const code = errorCode(e);
      if (code !== "ALREADY_EXISTS" && code !== "FORK_IN_PROGRESS") throw e;
    }
  }

  /**
   * Gives a fresh fork its own copy of the objects it inherited. An Artifacts fork shares its
   * parent's objects, and a fork of a large repo cannot serve them: every fetch that needs them in
   * bulk (a clone, even `--depth=1 --filter=blob:none`) answers HTTP 500, while `ls-refs` and
   * incremental fetches work (verified 2026-10-03 on this platform's own 18 MB history; small
   * template repos never showed it). CI checkouts, workspaces and agents all clone forks, so every
   * fork gets the default branch's full history pushed into it once, under `FORK_OBJECTS_REF`
   * (not a branch: the PushRouter ignores it). Idempotent: a fork that has the ref is skipped.
   */
  private async hydrateFork(source: string, target: string, branch: string): Promise<void> {
    const to = await this.remote(target, "write");
    const refs = await this.opts.wire.listRefs(to);
    if (refs.has(FORK_OBJECTS_REF)) return;
    const head = refs.get(`refs/heads/${branch}`);
    if (head === undefined) return; // nothing inherited
    const from = await this.remote(source, "read");
    // haves: [] — the fork advertises the head already; only a full pack makes the objects its own.
    const r = await this.opts.wire.transferObjects(from, to, {
      sha: head,
      toRef: FORK_OBJECTS_REF,
      oldSha: ZERO,
      haves: [],
    });
    if (!r.ok) throw new Error(`hydrating fork ${target} failed: ${r.reason ?? "unknown"}`);
  }

  async deleteRepo(name: string): Promise<void> {
    this.guardWrite(name);
    await this.opts.binding.delete(name);
  }

  async mintToken(
    repo: string,
    scope: "read" | "write",
    ttlSeconds: number,
  ): Promise<{ token: string; expiresAt: string }> {
    let ttl = Math.max(60, Math.trunc(ttlSeconds));
    if (scope === "write") {
      this.guardWrite(repo);
      ttl = Math.min(ttl, isForkName(repo) ? MAX_FORK_TOKEN_TTL : MAX_MAIN_WRITE_TOKEN_TTL);
    }
    const { plaintext, expiresAt } = await this.withRepo(repo, (r) => r.createToken(scope, ttl));
    return { token: plaintext, expiresAt };
  }

  /**
   * Import by push (see `GitHost.mintImportToken`): every role may call it, because it only
   * mints for a main repo that has no `refs/heads/<branch>` (read from the repo's advertised
   * refs just before minting). A token Artifacts returns without an id could never be revoked,
   * so it is refused (it expires unused).
   */
  async mintImportToken(
    repo: string,
    input: { branch: string; ttlSeconds: number },
  ): Promise<{ token: string; tokenId: string; expiresAt: string }> {
    if (isForkName(repo)) {
      throw new GitWriteForbiddenError(`import grants are for project repos, not forks (${repo})`);
    }
    const refs = await this.opts.wire.listRefs(await this.remote(repo, "read"));
    if (refs.has(`refs/heads/${input.branch}`)) {
      throw new GitWriteForbiddenError(
        `${repo} already has ${input.branch}: an import grant is only for a repo before its first push`,
      );
    }
    const ttl = Math.min(Math.max(60, Math.trunc(input.ttlSeconds)), MAX_IMPORT_TOKEN_TTL);
    const created = await this.withRepo(repo, (r) => r.createToken("write", ttl));
    if (typeof created.id !== "string" || created.id === "") {
      throw new Error("Artifacts returned a token without an id: refusing an unrevocable grant");
    }
    return { token: created.plaintext, tokenId: created.id, expiresAt: created.expiresAt };
  }

  /** The token index is eventually consistent (about 1 s after minting): retry a miss briefly. */
  async revokeToken(repo: string, tokenId: string): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      const revoked = await this.withRepo(repo, async (r) => {
        if (r.revokeToken === undefined) throw new Error("this Artifacts binding cannot revoke");
        return r.revokeToken(tokenId);
      });
      if (revoked || attempt >= 3) return revoked;
      await this.sleep(500 * (attempt + 1));
    }
  }

  // ------------------------------------------------------------ reads

  async branchHead(repo: string, branch: string): Promise<string | null> {
    return this.withRepo(
      repo,
      async (r) => (await r.log({ ref: branch, limit: 1 }))[0]?.hash ?? null,
    );
  }

  async commitParents(repo: string, sha: string): Promise<string[] | null> {
    return this.withRepo(repo, async (r) => (await r.readCommit(sha))?.parents ?? null);
  }

  async commitMessage(repo: string, sha: string): Promise<string | null> {
    return this.withRepo(repo, async (r) => (await r.readCommit(sha))?.message ?? null);
  }

  async treeOf(repo: string, sha: string): Promise<string | null> {
    return this.withRepo(repo, async (r) => (await r.readCommit(sha))?.treeHash ?? null);
  }

  async readFile(repo: string, ref: string, path: string): Promise<Uint8Array | null> {
    return this.withRepo(repo, async (r) => {
      const blob = await r.readFile({ ref, path });
      return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
    });
  }

  async diff(
    repo: string,
    baseSha: string | null,
    headSha: string,
    opts: { maxFileBytes?: number } = {},
  ): Promise<ChangeDiff> {
    return this.withRepo(repo, async (r) => {
      const [base, head] = await Promise.all([
        baseSha === null ? null : r.readCommit(baseSha),
        r.readCommit(headSha),
      ]);
      if ((baseSha !== null && base === null) || head === null)
        throw new Error(`commit ${head === null ? headSha : baseSha} not found in ${repo}`);
      const reader: TreeReader = {
        readTree: (hash) => r.readTree(hash),
        readBlob: async (hash) => {
          const blob = await r.readBlob(hash);
          return blob === null
            ? null
            : { size: blob.size, bytes: async () => new Uint8Array(await blob.arrayBuffer()) };
        },
      };
      return diffTrees(
        reader,
        {
          baseSha: baseSha ?? ZERO,
          headSha,
          baseTree: base?.treeHash ?? null,
          headTree: head.treeHash,
        },
        opts.maxFileBytes === undefined ? {} : { maxFileBytes: opts.maxFileBytes },
      );
    });
  }

  // ------------------------------------------------------------ browsing

  async resolveRef(repo: string, ref: string): Promise<string | null> {
    return this.withRepo(repo, async (r) => {
      if (/^[0-9a-f]{40}$/.test(ref)) return (await r.readCommit(ref))?.hash ?? null;
      return (await r.log({ ref, limit: 1 }))[0]?.hash ?? null;
    });
  }

  async readCommit(repo: string, sha: string): Promise<GitCommitInfo | null> {
    return this.withRepo(repo, async (r) => {
      const c = await r.readCommit(sha);
      return c === null ? null : commitInfo(c);
    });
  }

  async log(
    repo: string,
    ref: string,
    opts: { limit: number; offset?: number },
  ): Promise<GitCommitInfo[]> {
    return this.withRepo(repo, async (r) => {
      const rows = await r.log({ ref, limit: opts.limit, offset: opts.offset ?? 0 });
      // `log` carries the metadata; a row without it (older runtimes) is read on its own.
      return Promise.all(
        rows.map(async (row) => {
          if (row.treeHash !== undefined && row.parents !== undefined)
            return commitInfo(row as ArtifactsCommitLike);
          const full = await r.readCommit(row.hash);
          if (full === null) throw new Error(`commit ${row.hash} in ${repo} log is unreadable`);
          return commitInfo(full);
        }),
      );
    });
  }

  async readPath(
    repo: string,
    sha: string,
    path: string,
    opts: { maxBytes: number },
  ): Promise<GitPath | null> {
    return this.withRepo(repo, async (r) => {
      const commit = await r.readCommit(sha);
      if (commit === null) return null;
      let tree = commit.treeHash;
      const parts = path === "" ? [] : path.split("/");
      for (const [i, name] of parts.entries()) {
        const entries = await r.readTree(tree);
        const entry = entries?.find((e) => e.name === name);
        if (entry === undefined) return null;
        if (entry.type === "tree") {
          tree = entry.hash;
          continue;
        }
        // A file in the middle of the path ("README.md/x") names nothing.
        if (i < parts.length - 1) return null;
        if (entry.type === "gitlink")
          return { type: "blob", sha: entry.hash, mode: entry.mode, size: 0, bytes: null };
        const blob = await r.readBlob(entry.hash);
        if (blob === null) return null;
        const bytes = blob.size <= opts.maxBytes ? new Uint8Array(await blob.arrayBuffer()) : null;
        return { type: "blob", sha: entry.hash, mode: entry.mode, size: blob.size, bytes };
      }
      const entries = await r.readTree(tree);
      if (entries === null) return null;
      return {
        type: "tree",
        sha: tree,
        entries: entries.map(
          (e): GitTreeItem => ({ name: e.name, mode: e.mode, sha: e.hash, type: e.type }),
        ),
      };
    });
  }

  async readNote(
    repo: string,
    targetSha: string,
    notesRef = "refs/notes/evidence",
  ): Promise<string | null> {
    return this.opts.wire.readNote(await this.remote(repo, "read"), notesRef, targetSha);
  }

  // ------------------------------------------------------------ writes (gitwire)

  async writeNote(
    repo: string,
    targetSha: string,
    content: string,
    opts: { notesRef?: string; mode?: "replace" | "append" } = {},
  ): Promise<void> {
    await this.opts.wire.writeNote(await this.remote(repo, "write"), {
      targetSha,
      content,
      author: this.committer,
      ...(opts.notesRef === undefined ? {} : { notesRef: opts.notesRef }),
      ...(opts.mode === undefined ? {} : { mode: opts.mode }),
    });
  }

  async transferObjects(
    fromRepo: string,
    toRepo: string,
    sha: string,
    toRef: string,
  ): Promise<void> {
    const [from, to] = await Promise.all([
      this.remote(fromRepo, "read"),
      this.remote(toRepo, "write"),
    ]);
    const result = await this.opts.wire.transferObjects(from, to, { sha, toRef });
    if (!result.ok)
      throw new Error(`transfer to ${toRepo} ${toRef} failed: ${result.reason ?? "unknown"}`);
  }

  /**
   * GitHub mode: fetch from GitHub (the installation token as `x-access-token` basic auth) into
   * a mirror, incrementally (the mirror's tips are the haves). The GitHub fetch never uses this
   * host's own `fetch` (that one reaches Artifacts).
   */
  async fetchExternal(
    source: { url: string; auth?: { basic: { username: string; password: string } } },
    toRepo: string,
    input: { sha: string; toRef: string },
  ): Promise<void> {
    if (!/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/.test(source.url)) {
      throw new Error("fetchExternal only reads from github.com repositories");
    }
    const to = await this.remote(toRepo, "write");
    const from: WireRemote = {
      url: source.url,
      ...(source.auth === undefined ? {} : { auth: source.auth }),
    };
    const result = await this.opts.wire.transferObjects(from, to, {
      sha: input.sha,
      toRef: input.toRef,
    });
    if (!result.ok) {
      throw new Error(
        `mirror fetch into ${toRepo} ${input.toRef} failed: ${result.reason ?? "unknown"}`,
      );
    }
  }

  async updateRef(
    repo: string,
    ref: string,
    oldSha: string,
    newSha: string,
  ): Promise<FastForwardResult> {
    const remote = await this.remote(repo, "write");
    try {
      await this.opts.wire.fastForward(remote, ref, oldSha, newSha);
      return { ok: true };
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      const detail = refErrorReason(e);
      if (name === "StaleRefError") return { ok: false, reason: "stale", detail };
      if (name === "MissingObjectError") return { ok: false, reason: "missing-object", detail };
      if (name === "RejectedError") return { ok: false, reason: "rejected", detail };
      throw e;
    }
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
    const remote = await this.remote(repo, "write");
    const now = Math.floor(Date.now() / 1000);
    const signature = { ...this.committer, timestamp: now, timezone: "+0000" };
    const message = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
    const { wire } = this.opts;
    const commit: WireObject = {
      type: "commit",
      data: wire.encodeCommit({
        tree: input.treeSha,
        parents: input.parents,
        author: signature,
        committer: signature,
        message,
      }),
    };
    const sha = await wire.hashObject(commit);
    const ref = `refs/heads/${input.branch}`;
    const report = await wire.receivePack(
      remote,
      [{ ref, oldSha: input.expectedOld, newSha: sha }],
      await wire.buildPack([commit]),
    );
    wire.assertRefUpdated(report, ref);
    return { sha };
  }

  /**
   * The first commit of an empty repo, pushed with compare-and-swap against "no branch": the
   * receive-pack command's old SHA is zero, so Artifacts refuses it once the branch exists. That
   * makes it the one main-repo write allowed outside the merge queue: it can create history but
   * never change it. The write token is minted for this push only (TTL <= 300 s) and never leaves.
   */
  async writeInitialCommit(
    repo: string,
    input: {
      branch: string;
      files: Readonly<Record<string, string | Uint8Array>>;
      message: string;
      author?: { name: string; email: string };
    },
  ): Promise<{ sha: string; treeSha: string }> {
    const { wire } = this.opts;
    if (Object.keys(input.files).length === 0) throw new TypeError("an initial commit needs files");
    const objects: WireObject[] = [];
    const seen = new Set<string>();
    const put = async (obj: WireObject): Promise<string> => {
      const sha = await wire.hashObject(obj);
      if (!seen.has(sha)) {
        seen.add(sha);
        objects.push(obj);
      }
      return sha;
    };
    const writeDir = async (dir: DirNode): Promise<string> => {
      const entries: Array<{ mode: string; name: string; sha: string }> = [];
      for (const [name, data] of dir.files) {
        entries.push({ mode: "100644", name, sha: await put({ type: "blob", data }) });
      }
      for (const [name, sub] of dir.dirs) {
        entries.push({ mode: "40000", name, sha: await writeDir(sub) });
      }
      return put({ type: "tree", data: wire.encodeTree(entries) });
    };
    const treeSha = await writeDir(fileTree(input.files));
    const now = Math.floor(Date.now() / 1000);
    const author = { ...(input.author ?? this.committer), timestamp: now, timezone: "+0000" };
    const committer = { ...this.committer, timestamp: now, timezone: "+0000" };
    const message = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
    const sha = await put({
      type: "commit",
      data: wire.encodeCommit({ tree: treeSha, parents: [], author, committer, message }),
    });
    const ref = `refs/heads/${input.branch}`;
    const remote = await this.remote(repo, "write", { createOnly: true });
    const report = await wire.receivePack(
      remote,
      [{ ref, oldSha: ZERO, newSha: sha }],
      await wire.buildPack(objects),
    );
    wire.assertRefUpdated(report, ref);
    return { sha, treeSha };
  }
}
