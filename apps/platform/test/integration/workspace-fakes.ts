/**
 * An in-memory `WorkspaceMachine` for workerd tests, where containers (and child processes) can't
 * run. The Workspace Durable Object around it is the real one: lifecycle, TTL, idle sleep,
 * quotas, path rules, output caps, owner checks and token minting all run as in production.
 *
 * What it fakes:
 * - the checkout: the fork's files at the head, read from the integration FakeGitHost;
 * - `exec`: a command handler the test installs (`fakeWorkspaces().onExec`), so "pnpm test"
 *   can pass or fail depending on the files the agent wrote; anything else echoes;
 * - the push: a commit on the fork's branch in FakeGitHost (with the same non-fast-forward rule),
 *   recorded in `pushes` so the test can deliver Artifacts' push event to the PushRouter;
 * - snapshots: copies of the file map.
 * The real container scripts are covered by test-node/workspace-scripts.spec.ts.
 */
import type {
  BootSpec,
  CheckoutSpec,
  CommitPushOutcome,
  CommitPushSpec,
  DiffOutcome,
  ExecOutcome,
  ExecSpec,
  PatchOutcome,
  ReadOutcome,
  WorkspaceMachine,
  WriteOutcome,
} from "../../src/workspace/machine.js";
import { MachineError } from "../../src/workspace/machine.js";
import { integrationFakes } from "./fakes.js";

export type Files = Record<string, string>;
export type ExecHandler = (
  command: string,
  files: Readonly<Files>,
) => { exitCode: number; stdout: string; stderr?: string } | null;

export interface FakeWorkspaces {
  machines: Map<string, FakeWorkspaceMachine>;
  onExec: ExecHandler | null;
  pushes: Array<{ fork: string; branch: string; before: string; after: string }>;
  /** Snapshots that can no longer be restored (simulates expiry or another image digest). */
  lostSnapshots: Set<string>;
}

const KEY = "__gittifactsFakeWorkspaces";

export function fakeWorkspaces(): FakeWorkspaces {
  const g = globalThis as unknown as Record<string, FakeWorkspaces | undefined>;
  g[KEY] ??= { machines: new Map(), onExec: null, pushes: [], lostSnapshots: new Set() };
  return g[KEY];
}

export function resetFakeWorkspaces(): FakeWorkspaces {
  const fresh: FakeWorkspaces = {
    machines: new Map(),
    onExec: null,
    pushes: [],
    lostSnapshots: new Set(),
  };
  (globalThis as unknown as Record<string, FakeWorkspaces>)[KEY] = fresh;
  return fresh;
}

/** The machine for one workspace id (one per DO; kept across DO restarts, like a container). */
export function fakeMachineFor(name: string): FakeWorkspaceMachine {
  const all = fakeWorkspaces().machines;
  let m = all.get(name);
  if (m === undefined) {
    m = new FakeWorkspaceMachine(name);
    all.set(name, m);
  }
  return m;
}

const snapshots = new Map<string, { files: Files; head: string | null }>();
let snapshotCounter = 0;

function forkOf(remote: string): string {
  return /\/([^/]+)\.git$/.exec(remote)?.[1] ?? remote;
}

function lines(text: string | undefined): number {
  if (text === undefined || text === "") return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

export class FakeWorkspaceMachine implements WorkspaceMachine {
  running = false;
  files: Files = {};
  head: string | null = null;
  readonly boots: BootSpec[] = [];
  readonly tokens: Array<{ op: "checkout" | "push"; token: string }> = [];
  readonly execs: ExecSpec[] = [];

  constructor(readonly name: string) {}

  async boot(spec: BootSpec): Promise<void> {
    this.boots.push(structuredClone(spec));
    if (this.running) return;
    if (spec.from.kind !== "image") {
      const snap = snapshots.get(spec.from.id);
      if (spec.from.kind === "sleep-snapshot") {
        if (snap === undefined || fakeWorkspaces().lostSnapshots.has(spec.from.id)) {
          throw new MachineError("snapshot-unavailable", `snapshot ${spec.from.id} is gone`);
        }
        this.files = { ...snap.files };
        this.head = snap.head;
      } else if (fakeWorkspaces().lostSnapshots.has(spec.from.id)) {
        throw new MachineError("snapshot-unavailable", `snapshot ${spec.from.id} is gone`);
      } else {
        // A CI dependency snapshot: node_modules, nothing tracked.
        this.files = { "node_modules/.installed": "yes\n" };
      }
    } else {
      this.files = {};
    }
    this.running = true;
  }

  async checkout(spec: CheckoutSpec): Promise<{ head: string }> {
    this.tokens.push({ op: "checkout", token: spec.token });
    const tracked = integrationFakes().git.filesAt(spec.headSha);
    const untracked = Object.fromEntries(
      Object.entries(this.files).filter(([p]) => p.startsWith("node_modules/")),
    );
    this.files = { ...untracked, ...tracked };
    this.head = spec.headSha;
    return { head: spec.headSha };
  }

  async exec(spec: ExecSpec): Promise<ExecOutcome> {
    this.execs.push(structuredClone(spec));
    const handled = fakeWorkspaces().onExec?.(spec.command, this.files) ?? null;
    const r = handled ?? { exitCode: 0, stdout: `$ ${spec.command}\n`, stderr: "" };
    const cap = (t: string) => ({
      text: t.length > spec.maxOutputBytes ? t.slice(-spec.maxOutputBytes) : t,
      bytes: t.length,
      truncated: t.length > spec.maxOutputBytes,
    });
    return {
      exitCode: r.exitCode,
      timedOut: false,
      durationMs: 5,
      stdout: cap(r.stdout),
      stderr: cap(r.stderr ?? ""),
    };
  }

  async read(path: string, maxBytes: number): Promise<ReadOutcome> {
    const text = this.files[path];
    if (text === undefined) return { ok: false, reason: "missing", message: "no such file" };
    const bytes = new TextEncoder().encode(text);
    return { ok: true, bytes: bytes.subarray(0, maxBytes), size: bytes.byteLength };
  }

  async write(path: string, content: Uint8Array): Promise<WriteOutcome> {
    const created = this.files[path] === undefined;
    this.files[path] = new TextDecoder().decode(content);
    return { ok: true, created };
  }

  async applyPatch(): Promise<PatchOutcome> {
    return { ok: false, reason: "rejected", message: "the fake machine does not apply patches" };
  }

  private tracked(): Files {
    return Object.fromEntries(
      Object.entries(this.files).filter(([p]) => !p.startsWith("node_modules/")),
    );
  }

  async diff(baseSha: string): Promise<DiffOutcome> {
    const base = integrationFakes().git.filesAt(baseSha);
    const now = this.tracked();
    const files: DiffOutcome["files"] = [];
    for (const path of [...new Set([...Object.keys(base), ...Object.keys(now)])].sort()) {
      if (base[path] === now[path]) continue;
      files.push({
        path,
        status:
          base[path] === undefined ? "added" : now[path] === undefined ? "deleted" : "modified",
        additions: lines(now[path]),
        deletions: lines(base[path]),
      });
    }
    return {
      files,
      patch: files.map((f) => `diff --git a/${f.path} b/${f.path}\n`).join(""),
      truncated: false,
    };
  }

  async commitPush(spec: CommitPushSpec): Promise<CommitPushOutcome> {
    this.tokens.push({ op: "push", token: spec.token });
    const git = integrationFakes().git;
    const fork = forkOf(spec.remote);
    const before = git.filesAt(spec.pushedHead);
    const now = this.tracked();
    const changes: Record<string, string | null> = {};
    for (const path of new Set([...Object.keys(before), ...Object.keys(now)])) {
      if (before[path] !== now[path]) changes[path] = now[path] ?? null;
    }
    if (Object.keys(changes).length === 0) return { status: "nothing", head: spec.pushedHead };
    const tip = await git.branchHead(fork, spec.branch);
    if (tip !== spec.pushedHead) {
      return { status: "rejected", head: null, message: "! [rejected] (fetch first)" };
    }
    const after = git.commit(fork, spec.branch, changes, spec.message);
    this.head = after;
    fakeWorkspaces().pushes.push({ fork, branch: spec.branch, before: spec.pushedHead, after });
    return {
      status: "pushed",
      head: after,
      before: spec.pushedHead,
      committed: true,
      files: Object.keys(changes).length,
    };
  }

  async snapshot(): Promise<{ id: string }> {
    const id = `ws-snap-${++snapshotCounter}`;
    snapshots.set(id, { files: { ...this.files }, head: this.head });
    return { id };
  }

  async destroy(): Promise<void> {
    this.running = false;
  }
}
