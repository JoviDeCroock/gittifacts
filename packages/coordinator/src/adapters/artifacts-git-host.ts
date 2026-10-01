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
import type { FastForwardResult, GitHost } from "../ports.js";
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
  transferObjects(from: WireRemote, to: WireRemote, opts: { sha: string; toRef: string }): Promise<WireRefResult>;
  fastForward(remote: WireRemote, ref: string, oldSha: string, newSha: string): Promise<WireRefResult>;
  receivePack(
    remote: WireRemote,
    updates: Array<{ ref: string; oldSha: string; newSha: string }>,
    pack?: Uint8Array,
  ): Promise<WirePushReport>;
  assertRefUpdated(report: WirePushReport, ref: string): WireRefResult;
  encodeCommit(c: {
    tree: string;
    parents: string[];
    author: { name: string; email: string; timestamp: number; timezone: string };
    committer: { name: string; email: string; timestamp: number; timezone: string };
    message: string;
  }): Uint8Array;
  hashObject(obj: WireObject): Promise<string>;
  buildPack(objects: readonly WireObject[]): Promise<Uint8Array>;
}

/** Structural slice of the Artifacts repo handle (`ArtifactsRepo` satisfies it). */
export interface ArtifactsRepoLike {
  createToken(scope?: "write" | "read", ttl?: number): Promise<{ plaintext: string; expiresAt: string }>;
  info(): Promise<{ defaultBranch: string; remote: string }>;
  readBlob(hash: string): Promise<Blob | null>;
  readTree(hash: string): Promise<Array<{ name: string; mode: string; hash: string; type: "tree" | "blob" | "symlink" | "gitlink" | "exec" }> | null>;
  readCommit(hash: string): Promise<{ hash: string; treeHash: string; parents: string[] } | null>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<Array<{ hash: string }>>;
  fork(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }): Promise<{ remote: string }>;
}

/** Structural slice of the `Artifacts` binding. */
export interface ArtifactsBindingLike {
  create(name: string, opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string }): Promise<{ remote: string; defaultBranch: string }>;
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
const INTERNAL_TOKEN_TTL = 300;

export class GitWriteForbiddenError extends Error {
  override name = "GitWriteForbiddenError";
}

function errorCode(e: unknown): string | null {
  if (typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  const m = e instanceof Error ? /\b(ALREADY_EXISTS|NOT_FOUND|[A-Z]+_IN_PROGRESS)\b/.exec(e.message) : null;
  return m?.[1] ?? null;
}

function refErrorReason(e: unknown): string {
  if (typeof e === "object" && e !== null && typeof (e as { reason?: unknown }).reason === "string") {
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
      throw new GitWriteForbiddenError(`this GitHost may not write to ${repo} (only the merge queue writes main repos)`);
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
    const { plaintext } = await this.withRepo(repo, (r) => r.createToken(scope, INTERNAL_TOKEN_TTL));
    this.tokens.set(key, { token: plaintext, until: Date.now() + (INTERNAL_TOKEN_TTL - 30) * 1000 });
    return plaintext;
  }

  private async remote(repo: string, scope: "read" | "write"): Promise<WireRemote> {
    const remote: WireRemote = { url: this.remoteOf(repo), auth: { bearer: await this.internalToken(repo, scope) } };
    if (this.opts.fetch) remote.fetch = this.opts.fetch;
    return remote;
  }

  // ------------------------------------------------------------ control plane

  remoteOf(name: string): string {
    return `https://${this.opts.accountId}.artifacts.cloudflare.net/git/${this.namespace}/${name}.git`;
  }

  async createRepo(name: string, opts: { defaultBranch: string; description?: string }): Promise<{ remote: string }> {
    const created = await this.opts.binding.create(name, {
      setDefaultBranch: opts.defaultBranch,
      ...(opts.description === undefined ? {} : { description: opts.description }),
    });
    return { remote: created.remote };
  }

  async importRepo(name: string, url: string, opts: { branch?: string } = {}): Promise<{ remote: string; defaultBranch: string }> {
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

  async forkRepo(source: string, target: string, opts: { readOnly?: boolean } = {}): Promise<{ remote: string }> {
    try {
      await this.withRepo(source, (r) =>
        r.fork(target, { defaultBranchOnly: true, ...(opts.readOnly === undefined ? {} : { readOnly: opts.readOnly }) }),
      );
    } catch (e) {
      // Idempotent: a retried fork finds its target already there (or still being created).
      const code = errorCode(e);
      if (code !== "ALREADY_EXISTS" && code !== "FORK_IN_PROGRESS") throw e;
    }
    const info = await this.waitReady(target);
    return { remote: info.remote };
  }

  async deleteRepo(name: string): Promise<void> {
    this.guardWrite(name);
    await this.opts.binding.delete(name);
  }

  async mintToken(repo: string, scope: "read" | "write", ttlSeconds: number): Promise<{ token: string; expiresAt: string }> {
    let ttl = Math.max(60, Math.trunc(ttlSeconds));
    if (scope === "write") {
      this.guardWrite(repo);
      ttl = Math.min(ttl, isForkName(repo) ? MAX_FORK_TOKEN_TTL : MAX_MAIN_WRITE_TOKEN_TTL);
    }
    const { plaintext, expiresAt } = await this.withRepo(repo, (r) => r.createToken(scope, ttl));
    return { token: plaintext, expiresAt };
  }

  // ------------------------------------------------------------ reads

  async branchHead(repo: string, branch: string): Promise<string | null> {
    return this.withRepo(repo, async (r) => (await r.log({ ref: branch, limit: 1 }))[0]?.hash ?? null);
  }

  async commitParents(repo: string, sha: string): Promise<string[] | null> {
    return this.withRepo(repo, async (r) => (await r.readCommit(sha))?.parents ?? null);
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

  async diff(repo: string, baseSha: string, headSha: string, opts: { maxFileBytes?: number } = {}): Promise<ChangeDiff> {
    return this.withRepo(repo, async (r) => {
      const [base, head] = await Promise.all([r.readCommit(baseSha), r.readCommit(headSha)]);
      if (base === null || head === null) throw new Error(`commit ${base === null ? baseSha : headSha} not found in ${repo}`);
      const reader: TreeReader = {
        readTree: (hash) => r.readTree(hash),
        readBlob: async (hash) => {
          const blob = await r.readBlob(hash);
          return blob === null ? null : { size: blob.size, bytes: async () => new Uint8Array(await blob.arrayBuffer()) };
        },
      };
      return diffTrees(
        reader,
        { baseSha, headSha, baseTree: base.treeHash, headTree: head.treeHash },
        opts.maxFileBytes === undefined ? {} : { maxFileBytes: opts.maxFileBytes },
      );
    });
  }

  async readNote(repo: string, targetSha: string, notesRef = "refs/notes/evidence"): Promise<string | null> {
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

  async transferObjects(fromRepo: string, toRepo: string, sha: string, toRef: string): Promise<void> {
    const [from, to] = await Promise.all([this.remote(fromRepo, "read"), this.remote(toRepo, "write")]);
    const result = await this.opts.wire.transferObjects(from, to, { sha, toRef });
    if (!result.ok) throw new Error(`transfer to ${toRepo} ${toRef} failed: ${result.reason ?? "unknown"}`);
  }

  async updateRef(repo: string, ref: string, oldSha: string, newSha: string): Promise<FastForwardResult> {
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
    input: { treeSha: string; parents: string[]; message: string; branch: string; expectedOld: string },
  ): Promise<{ sha: string }> {
    const remote = await this.remote(repo, "write");
    const now = Math.floor(Date.now() / 1000);
    const signature = { ...this.committer, timestamp: now, timezone: "+0000" };
    const message = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
    const { wire } = this.opts;
    const commit: WireObject = {
      type: "commit",
      data: wire.encodeCommit({ tree: input.treeSha, parents: input.parents, author: signature, committer: signature, message }),
    };
    const sha = await wire.hashObject(commit);
    const ref = `refs/heads/${input.branch}`;
    const report = await wire.receivePack(remote, [{ ref, oldSha: input.expectedOld, newSha: sha }], await wire.buildPack([commit]));
    wire.assertRefUpdated(report, ref);
    return { sha };
  }
}
