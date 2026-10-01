/**
 * Fakes for the Workers integration tests. The Workers test runtime has no containers and no
 * Artifacts simulator, so the Runner gets a `FakeContainer` and the Workflow a fake repo reader.
 *
 * FakeContainer interprets `fake:<directive>` tokens in commands:
 *   fake:sleep=<ms>  fake:exit=<n>  fake:out=<text>  fake:touch=<file>  fake:require=<file>
 *   fake:crash (exec rejects)  fake:printtoken  fake:env (prints the env keys)
 * plus `gittifacts-runner evidence <kind>` and `gittifacts-runner plan`.
 * Its filesystem and snapshots live in R2 so they are visible across Durable Objects, and it
 * records every start/exec/snapshot/destroy as an event in R2 for assertions.
 */
import type { RepoReader } from "../../src/cache/tree.js";
import type { ContainerLike, ExecProcessLike } from "../../src/runner/container.js";
import { EVIDENCE_OUT } from "../../src/runner/shell.js";

export const FAKE_TOKEN = "art_v2_e_feedfacefeedfacefeedfacefeedface0000?expires=1999999999";
export const BAD_SHA = "d".repeat(40);

type FakeTree = { [name: string]: string | FakeTree };

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "fixture", scripts });

export const SHAS = {
  base: "1".repeat(40),
  head: "2".repeat(40),
  head2: "3".repeat(40),
  withCiFile: "4".repeat(40),
  badCiFile: "5".repeat(40),
  defaults: "6".repeat(40),
};

const nodeRepo: FakeTree = {
  "package.json": pkg({ test: "vitest run", lint: "biome check", build: "tsc" }),
  "pnpm-lock.yaml": "lockfileVersion: 9",
  src: { "index.ts": "export const x = 1;" },
};

export const FAKE_COMMITS: Record<string, FakeTree> = {
  [SHAS.base]: nodeRepo,
  [SHAS.head]: { ...nodeRepo, src: { "index.ts": "export const x = 2;" } },
  [SHAS.head2]: { ...nodeRepo, src: { "index.ts": "export const x = 3;" } },
  [SHAS.withCiFile]: {
    ...nodeRepo,
    ".platform": {
      "ci.ts": JSON.stringify({
        version: 1,
        source: "file",
        steps: [
          { name: "deps", command: "fake:touch=node_modules", parent: null, after: [] },
          { name: "unit", command: "fake:require=node_modules", parent: "deps", after: [] },
        ],
        warnings: [],
      }),
    },
  },
  [SHAS.badCiFile]: { ...nodeRepo, ".platform": { "ci.ts": "THROW" } },
  [SHAS.defaults]: {
    "package.json": pkg({ test: "fake:require=node_modules", typecheck: "fake:exit=0" }),
    "pnpm-lock.yaml": "lockfileVersion: 9",
  },
};

function hex(s: string): string {
  let h = 0;
  for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0").repeat(5);
}

/** A RepoReader over FAKE_COMMITS. */
export function fakeRepo(): RepoReader {
  const trees = new Map<string, { name: string; mode: string; hash: string; type: string }[]>();
  const blobs = new Map<string, string>();
  const commits = new Map<string, string>();
  const build = (tree: FakeTree, path: string): string => {
    const entries = Object.entries(tree).map(([name, v]) => {
      if (typeof v === "string") {
        const hash = hex(`blob:${v}`);
        blobs.set(hash, v);
        return { name, mode: "100644", hash, type: "blob" };
      }
      return { name, mode: "40000", hash: build(v, `${path}/${name}`), type: "tree" };
    });
    const hash = hex(`tree:${path}:${JSON.stringify(entries)}`);
    trees.set(hash, entries);
    return hash;
  };
  for (const [sha, tree] of Object.entries(FAKE_COMMITS)) commits.set(sha, build(tree, sha));
  return {
    async readCommit(hash) {
      const treeHash = commits.get(hash);
      return treeHash === undefined ? null : { treeHash };
    },
    async readTree(hash) {
      return trees.get(hash) ?? null;
    },
    async readBlob(hash) {
      const v = blobs.get(hash);
      return v === undefined ? null : { text: async () => v, size: v.length };
    },
  };
}

function fileAt(sha: string | null, path: string): string | null {
  if (sha === null) return null;
  let node: string | FakeTree | undefined = FAKE_COMMITS[sha];
  for (const part of path.split("/")) {
    if (node === undefined || typeof node === "string") return null;
    node = node[part];
  }
  return typeof node === "string" ? node : null;
}

type FsState = {
  head: string | null;
  base: string | null;
  files: Record<string, string>;
  /** The workspace holds only cache inputs (no .git, no other repository files). */
  hermetic?: boolean;
};

export type FakeEvent = {
  kind: "start" | "exec" | "exit" | "snapshot" | "destroy" | "intercept" | "ca" | "hermetic";
  t: number;
  [key: string]: unknown;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FakeContainer implements ContainerLike {
  running = false;
  readonly images = { base: "registry.cloudflare.com/test/gittifacts-runner@sha256:0000" };
  private state: FsState | null = null;
  private startError: Error | null = null;
  private starting: Promise<void> = Promise.resolve();
  private seq = 0;
  private readonly kills = new Set<() => void>();
  private readonly monitors = new Set<{ resolve: () => void; reject: (e: Error) => void }>();

  constructor(
    private readonly bucket: R2Bucket,
    private readonly name: string,
  ) {}

  private async record(kind: FakeEvent["kind"], data: Record<string, unknown> = {}): Promise<void> {
    const n = String(this.seq++).padStart(4, "0");
    await this.bucket.put(
      `fake-events/${this.name}/${n}-${kind}.json`,
      JSON.stringify({ kind, t: Date.now(), ...data }),
    );
  }

  start(options: ContainerStartupOptions): void {
    if (this.running) throw new Error("container already running");
    this.running = true;
    this.startError = null;
    this.internet = options.enableInternet;
    this.httpsGateway = null;
    const snapshotId = options.containerSnapshot?.id ?? null;
    this.starting = (async () => {
      await this.record("start", {
        snapshot: snapshotId,
        image: options.image ?? null,
        instance: options.instance ?? null,
        enableInternet: options.enableInternet,
        labels: options.labels ?? null,
        env: options.env ?? null,
      });
      if (snapshotId === null) {
        this.state = { head: null, base: null, files: {}, hermetic: false };
        return;
      }
      const obj = await this.bucket.get(`fake-snapshots/${snapshotId}.json`);
      if (obj === null) {
        this.running = false;
        this.startError = new Error(`container snapshot ${snapshotId} not found`);
        for (const m of this.monitors) m.reject(this.startError);
        return;
      }
      this.state = JSON.parse(await obj.text()) as FsState;
    })();
  }

  monitor(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.startError !== null) reject(this.startError);
      else this.monitors.add({ resolve, reject });
    });
  }

  async setInactivityTimeout(): Promise<void> {}

  private internet = true;
  private httpsGateway: Fetcher | null = null;

  async interceptAllOutboundHttp(binding: Fetcher): Promise<void> {
    this.httpsGateway ??= binding;
    await this.record("intercept", { target: "http:*" });
  }

  async interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void> {
    if (addr === "*") this.httpsGateway = binding;
    await this.record("intercept", { target: `https:${addr}` });
  }

  async snapshotContainer(options: {
    name?: string;
  }): Promise<{ id: string; size: number; name?: string }> {
    if (!this.running || this.state === null) throw new Error("container is not running");
    const id = `snap-${options.name ?? "x"}-${crypto.randomUUID().slice(0, 8)}`;
    await this.bucket.put(`fake-snapshots/${id}.json`, JSON.stringify(this.state));
    await this.record("snapshot", { id });
    return { id, size: 4096, ...(options.name === undefined ? {} : { name: options.name }) };
  }

  async destroy(): Promise<void> {
    this.running = false;
    this.state = null;
    for (const k of this.kills) k();
    for (const m of this.monitors) m.resolve();
    this.monitors.clear();
    await this.record("destroy");
  }

  async exec(argv: string[], options: ContainerExecOptions = {}): Promise<ExecProcessLike> {
    await this.starting;
    if (this.startError !== null) throw this.startError;
    if (!this.running || this.state === null) throw new Error("container is not running");
    const script = argv[2] ?? argv.join(" ");
    if (script.includes("fake:crash")) throw new Error("exec failed: fake crash");
    const out = new TransformStream<Uint8Array, Uint8Array>();
    const err = new TransformStream<Uint8Array, Uint8Array>();
    const outWriter = out.writable.getWriter();
    const errWriter = err.writable.getWriter();
    const enc = new TextEncoder();
    const pipeOut = options.stdout !== "ignore";
    const pipeErr = options.stderr === "pipe";
    const write = async (s: string) => {
      if (pipeOut) await outWriter.write(enc.encode(s));
    };
    const writeErr = async (s: string) => {
      if (pipeErr) await errWriter.write(enc.encode(s));
      else if (options.stderr === "combined") await write(s);
    };
    let killed = false;
    let wake: () => void = () => {};
    const killedSignal = new Promise<void>((r) => {
      wake = r;
    });
    const kill = () => {
      killed = true;
      wake();
    };
    this.kills.add(kill);
    const exitCode = (async () => {
      try {
        return await this.interpret(
          argv,
          script,
          options,
          write,
          writeErr,
          killedSignal,
          () => killed,
        );
      } finally {
        this.kills.delete(kill);
        await outWriter.close().catch(() => {});
        await errWriter.close().catch(() => {});
      }
    })();
    return {
      stdout: pipeOut ? out.readable : null,
      stderr: pipeErr ? err.readable : null,
      exitCode,
    };
  }

  private async interpret(
    argv: string[],
    script: string,
    options: ContainerExecOptions,
    write: (s: string) => Promise<void>,
    writeErr: (s: string) => Promise<void>,
    killedSignal: Promise<void>,
    killed: () => boolean,
  ): Promise<number> {
    const state = this.state!;
    const env = options.env ?? {};
    if (argv[0] === "true") return 0;
    if (script.includes("update-ca-certificates")) {
      await this.record("ca", {});
      return 0;
    }
    if (script.includes("gittifacts-src")) {
      const list =
        options.stdin instanceof ReadableStream ? await new Response(options.stdin).text() : "";
      const inputs = list.split("\0").filter((p) => p !== "");
      state.hermetic = true;
      await this.record("hermetic", { inputs });
      await write(`workspace reduced to ${inputs.length} cache input files\n`);
      return 0;
    }
    if (script.includes("git fetch")) {
      state.hermetic = false;
      await write(`fetching from ${env.GITTIFACTS_REMOTE} with ${env.GIT_CONFIG_VALUE_0}\n`);
      if (env.GITTIFACTS_HEAD_SHA === BAD_SHA) {
        await write("fatal: remote error: object not found\n");
        return 128;
      }
      state.head = env.GITTIFACTS_HEAD_SHA ?? null;
      if (env.GITTIFACTS_BASE_SHA !== undefined) state.base = env.GITTIFACTS_BASE_SHA;
      await write(`checked out ${state.head}\n`);
      return 0;
    }
    if (script.startsWith("rm -rf /tmp/gittifacts")) {
      delete state.files[EVIDENCE_OUT];
      return 0;
    }
    if (script.includes(EVIDENCE_OUT) && script.includes("head -c")) {
      const content = state.files[EVIDENCE_OUT];
      if (content === undefined) return 3;
      await write(content);
      return 0;
    }

    const t0 = Date.now();
    await this.record("exec", {
      command: script,
      cwd: options.cwd ?? null,
      envKeys: Object.keys(env).sort(),
      head: state.head,
    });
    let code = 0;
    const plan = /gittifacts-runner plan/.test(script);
    const evidence = /gittifacts-runner evidence ([a-z-]+)/.exec(script);
    if (plan) {
      const file = fileAt(state.head, ".platform/ci.ts");
      if (file === null || file === "THROW") {
        await writeErr("Error: the pipeline function threw: boom\n");
        code = 1;
      } else {
        await writeErr("planning .platform/ci.ts\n");
        await write(file);
      }
    } else if (evidence !== null) {
      const kind = evidence[1]!;
      const item = { id: kind, kind: "sensitive-paths", status: "ok", patterns: [], hits: [] };
      if (kind === "policy") await write(`noise\n::evidence::${JSON.stringify(item)}\n`);
      else if (kind === "mutation") await write("::evidence::{not json\n");
      else state.files[EVIDENCE_OUT] = JSON.stringify([item]);
      await write(
        `evidence ${kind} base=${env.GITTIFACTS_BASE_SHA} head=${env.GITTIFACTS_HEAD_SHA}\n`,
      );
    }
    for (const m of script.matchAll(/fake:([a-z]+)(?:=([^\s']+))?/g)) {
      if (killed()) break;
      const [, directive, arg = ""] = m;
      if (directive === "sleep") await Promise.race([sleep(Number(arg)), killedSignal]);
      else if (directive === "exit") code = Number(arg);
      else if (directive === "out") await write(`${arg.replaceAll("_", " ")}\n`);
      else if (directive === "touch") state.files[arg] = "1";
      else if (directive === "require" && state.files[arg] === undefined) {
        await write(`error: ${arg} is missing\n`);
        code = 1;
      } else if (directive === "printtoken") await write(`leaked ${FAKE_TOKEN}\n`);
      else if (directive === "spam") await write(`${"x".repeat(Number(arg))}\n`);
      else if (directive === "env") await write(`env ${Object.keys(env).sort().join(",")}\n`);
      else if (directive === "needsrepo" && state.hermetic === true) {
        await write("error: src/setup.js not found\n");
        code = 1;
      } else if (directive === "curl") {
        if (this.httpsGateway !== null) {
          const res = await this.httpsGateway.fetch(arg);
          await write(`curl ${res.status} ${(await res.text()).trim()}\n`);
          if (res.status >= 400) code = 22;
        } else if (this.internet) {
          await write(`curl ${arg}: direct internet\n`);
        } else {
          await write(`curl: (6) Could not resolve host\n`);
          code = 6;
        }
      }
    }
    if (killed()) code = 137;
    await this.record("exit", { command: script, code, t0, t1: Date.now() });
    return code;
  }
}
