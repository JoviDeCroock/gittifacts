import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GitHttpError,
  MissingObjectError,
  RejectedError,
  RemoteError,
  StaleRefError,
  ZERO_SHA,
  buildPack,
  encodeCommit,
  encodeTree,
  fastForward,
  fetchPack,
  hashObject,
  listRefs,
  parsePack,
  receivePack,
  transferObjects,
} from "../src/index.js";
import { utf8 } from "../src/bytes.js";
import { type GitHttpServer, startGitHttpServer } from "./support/git-http-server.js";
import { commitFiles, git, initRepo, lorem, tempDir } from "./support/git.js";

const TOKEN = "art_v2_e_test?expires=9999999999";

let server: GitHttpServer;
let tmp: { path: string; cleanup: () => void };
let work: string;
let c1: string;
let c2: string;
let repoCounter = 0;

/** A fresh bare repo on the server, populated from the work repo. */
function seededRepo(refs = ["main", "feature", "--tags"], config?: Record<string, string>): string {
  const name = `repo-${++repoCounter}`;
  const path = server.createBareRepo(name, config);
  git(work, ["push", "-q", path, ...refs]);
  return name;
}

/** Records every request body our client sends. */
function recordingFetch(): { fetch: typeof fetch; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const wrapped = async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("latin1") : "";
    calls.push({ url: String(input), body });
    return fetch(input, init);
  };
  return { fetch: wrapped as typeof fetch, calls };
}

function lsRemote(name: string): Map<string, string> {
  const out = git(server.root, ["ls-remote", server.repoPath(name)]);
  return new Map(out.split("\n").map((l) => l.split("\t").reverse() as [string, string]));
}

beforeAll(async () => {
  server = await startGitHttpServer({ token: TOKEN });
  tmp = tempDir();
  work = initRepo(join(tmp.path, "work"));
  c1 = commitFiles(work, { "README.md": "# hi\n", "src/big.txt": lorem(1, 300) }, "c1");
  git(work, ["tag", "-a", "v1", "-m", "release v1"]);
  git(work, ["tag", "light"]);
  c2 = commitFiles(work, { "src/big.txt": `${lorem(1, 300)}more\n`, "src/new.txt": "new\n" }, "c2");
  git(work, ["branch", "feature"]);
  git(work, ["reset", "-q", "--hard", c1]);
});

afterAll(async () => {
  await server.close();
  tmp.cleanup();
});

describe("listRefs", () => {
  it("uses v2 ls-refs with peeled tags and the HEAD symref", async () => {
    const name = seededRepo();
    const refs = await listRefs(server.remote(name));
    expect(refs.protocol).toBe(2);
    expect(new Map(refs)).toEqual(lsRemote(name));
    expect(refs.get("refs/tags/v1^{}")).toBe(c1);
    expect(refs.symrefs.get("HEAD")).toBe("refs/heads/main");
    expect(server.log.filter((r) => r.gitProtocol === "version=2").length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to (or can force) the v1 advertisement", async () => {
    const name = seededRepo();
    const refs = await listRefs(server.remote(name), { protocol: 1 });
    expect(refs.protocol).toBe(1);
    expect(new Map(refs)).toEqual(lsRemote(name));
    expect(refs.symrefs.get("HEAD")).toBe("refs/heads/main");
    expect(refs.capabilities.has("side-band-64k")).toBe(true);
  });

  it("filters by prefix in both protocols", async () => {
    const name = seededRepo();
    for (const protocol of [1, 2] as const) {
      const refs = await listRefs(server.remote(name), { protocol, prefixes: ["refs/tags/"] });
      expect([...refs.keys()].sort()).toEqual(["refs/tags/light", "refs/tags/v1", "refs/tags/v1^{}"]);
    }
  });

  it("returns an empty map for an empty repo", async () => {
    server.createBareRepo("empty");
    expect((await listRefs(server.remote("empty"))).size).toBe(0);
    expect((await listRefs(server.remote("empty"), { protocol: 1 })).size).toBe(0); // bare flush
    const push = await listRefs(server.remote("empty"), { service: "git-receive-pack" });
    expect(push.size).toBe(0);
    expect(push.capabilities.has("report-status")).toBe(true); // carried by `capabilities^{}`
  });

  it("reads the receive-pack advertisement (always v1)", async () => {
    const name = seededRepo();
    const refs = await listRefs(server.remote(name), { service: "git-receive-pack" });
    expect(refs.protocol).toBe(1);
    expect(refs.get("refs/heads/main")).toBe(c1);
    for (const cap of ["report-status", "delete-refs", "ofs-delta", "side-band-64k", "atomic"]) {
      expect(refs.capabilities.has(cap), cap).toBe(true);
    }
  });

  it("authenticates with Bearer or Basic and surfaces 401s", async () => {
    const name = seededRepo();
    const basic = server.remote(name, { basic: { username: "x", password: TOKEN.split("?expires=")[0]! } });
    expect((await listRefs(basic)).get("refs/heads/main")).toBe(c1);
    const err = await listRefs(server.remote(name, null)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHttpError);
    expect((err as GitHttpError).status).toBe(401);
    await expect(listRefs(server.remote(name, { bearer: "wrong" }))).rejects.toThrow(/HTTP 401/);
  });
});

describe("receivePack / fastForward", () => {
  it("fast-forwards with CAS", async () => {
    const name = seededRepo();
    const result = await fastForward(server.remote(name), "refs/heads/main", c1, c2);
    expect(result).toEqual({ ref: "refs/heads/main", ok: true });
    expect(git(server.repoPath(name), ["rev-parse", "main"])).toBe(c2);
  });

  it("throws StaleRefError when the old SHA does not match", async () => {
    const name = seededRepo();
    const err = await fastForward(server.remote(name), "refs/heads/main", c2, c1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleRefError);
    expect((err as StaleRefError).ref).toBe("refs/heads/main");
    expect(git(server.repoPath(name), ["rev-parse", "main"])).toBe(c1);
  });

  it("throws MissingObjectError when the new tip is not in the repo", async () => {
    const name = seededRepo(["main"]);
    const unknown = "1234567890123456789012345678901234567890";
    await expect(fastForward(server.remote(name), "refs/heads/main", c1, unknown)).rejects.toBeInstanceOf(MissingObjectError);
    // c2 is a real commit, but this repo only has main (c1): still missing.
    await expect(fastForward(server.remote(name), "refs/heads/main", c1, c2)).rejects.toBeInstanceOf(MissingObjectError);
  });

  it("creates and deletes refs; delete-only pushes send no pack", async () => {
    const name = seededRepo();
    const rec = recordingFetch();
    const remote = server.remote(name, undefined, rec.fetch);
    const ref = "refs/merge-queue/7";
    expect((await receivePack(remote, [{ ref, oldSha: ZERO_SHA, newSha: c2 }])).refs).toEqual([{ ref, ok: true }]);
    expect(rec.calls.at(-1)?.body).toContain("PACK");
    await expect(fastForward(remote, ref, ZERO_SHA, c2)).rejects.toBeInstanceOf(StaleRefError); // already exists
    await expect(fastForward(remote, ref, c1, ZERO_SHA)).rejects.toBeInstanceOf(StaleRefError); // wrong old
    expect(await fastForward(remote, ref, c2, ZERO_SHA)).toEqual({ ref, ok: true });
    const body = rec.calls.at(-1)?.body ?? "";
    expect(body.endsWith("0000")).toBe(true);
    expect(body).not.toContain("PACK");
    expect(lsRemote(name).has(ref)).toBe(false);
  });

  it("pushes new objects built with buildPack", async () => {
    const name = seededRepo();
    const blob = { type: "blob" as const, data: utf8("written over the wire\n") };
    const base = git(server.repoPath(name), ["rev-parse", `${c2}^{tree}`]);
    const entries = git(server.repoPath(name), ["ls-tree", base]).split("\n").map((l) => {
      const [meta, entryName] = l.split("\t") as [string, string];
      const [mode, , sha] = meta.split(" ") as [string, string, string];
      return { mode: mode === "040000" ? "40000" : mode, name: entryName, sha };
    });
    const tree = { type: "tree" as const, data: encodeTree([...entries, { mode: "100644", name: "wire.txt", sha: await hashObject(blob) }]) };
    const sig = { name: "gitwire", email: "gitwire@example.com", timestamp: 1700000500, timezone: "+0000" };
    const commit = {
      type: "commit" as const,
      data: encodeCommit({ tree: await hashObject(tree), parents: [c2], author: sig, committer: sig, message: "wire commit\n" }),
    };
    const sha = await hashObject(commit);
    const report = await receivePack(
      server.remote(name),
      [{ ref: "refs/heads/feature", oldSha: c2, newSha: sha }],
      await buildPack([blob, tree, commit]),
    );
    expect(report).toMatchObject({ unpackOk: true, refs: [{ ref: "refs/heads/feature", ok: true }] });
    git(server.repoPath(name), ["fsck", "--full", "--strict"]);
    expect(git(server.repoPath(name), ["show", "feature:wire.txt"])).toBe("written over the wire");
  });

  it("applies multiple updates atomically when asked", async () => {
    const name = seededRepo();
    const report = await receivePack(
      server.remote(name),
      [
        { ref: "refs/heads/main", oldSha: c1, newSha: c2 },
        { ref: "refs/heads/feature", oldSha: c1 /* stale: feature is at c2 */, newSha: c1 },
      ],
      undefined,
      { atomic: true },
    );
    expect(report.refs.every((r) => !r.ok)).toBe(true);
    expect(git(server.repoPath(name), ["rev-parse", "main"])).toBe(c1);
  });

  it("reports hook rejections as RejectedError with sideband progress", async () => {
    const name = seededRepo();
    const hook = join(server.repoPath(name), "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'policy: only the merge queue writes main' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const report = await receivePack(server.remote(name), [{ ref: "refs/heads/main", oldSha: c1, newSha: c2 }]);
    expect(report.progress).toContain("only the merge queue writes main");
    await expect(fastForward(server.remote(name), "refs/heads/main", c1, c2)).rejects.toBeInstanceOf(RejectedError);
  });

  it("rejects invalid input before touching the network", async () => {
    const remote = server.remote("nope");
    await expect(receivePack(remote, [])).rejects.toThrow(TypeError);
    await expect(fastForward(remote, "main", c1, c2)).rejects.toThrow(/invalid ref name/);
    await expect(fastForward(remote, "refs/heads/x", "abc", c2)).rejects.toThrow(/SHA-1/);
    await expect(receivePack(remote, [{ ref: "refs/heads/x", oldSha: c1, newSha: ZERO_SHA }], await buildPack([]))).rejects.toThrow(/delete-only/);
  });
});

describe("fetchPack", () => {
  const objectsOf = (name: string, revs: string[]) =>
    new Set(git(server.repoPath(name), ["rev-list", "--objects", ...revs]).split("\n").map((l) => l.split(" ")[0]!));

  it("fetches a complete pack for a want", async () => {
    const name = seededRepo();
    const objects = await parsePack(await fetchPack(server.remote(name), { wants: [c2] }));
    expect(new Set(objects.map((o) => o.sha))).toEqual(objectsOf(name, [c2]));
  });

  it("honours haves, depth and blob:none", async () => {
    const name = seededRepo();
    const remote = server.remote(name);
    const incremental = await parsePack(await fetchPack(remote, { wants: [c2], haves: [c1] }));
    expect(new Set(incremental.map((o) => o.sha))).toEqual(objectsOf(name, [c2, `^${c1}`]));

    const shallow = await parsePack(await fetchPack(remote, { wants: [c2], depth: 1 }));
    expect(shallow.filter((o) => o.type === "commit").map((o) => o.sha)).toEqual([c2]);

    const blobless = await parsePack(await fetchPack(remote, { wants: [c2], depth: 1, filter: "blob:none" }));
    expect(blobless.some((o) => o.type === "blob")).toBe(false);
    expect(blobless.some((o) => o.type === "tree")).toBe(true);
  });

  it("fetches a single blob by id (protocol v2 wants are not limited to tips)", async () => {
    const name = seededRepo();
    const blob = git(server.repoPath(name), ["rev-parse", `${c2}:src/new.txt`]);
    const objects = await parsePack(await fetchPack(server.remote(name), { wants: [blob] }));
    expect(objects.map((o) => [o.sha, Buffer.from(o.data).toString()])).toEqual([[blob, "new\n"]]);
  });

  it("surfaces server-side ERR lines", async () => {
    const name = seededRepo();
    await expect(fetchPack(server.remote(name), { wants: ["1234567890123456789012345678901234567890"] })).rejects.toBeInstanceOf(RemoteError);
  });
});

describe("transferObjects", () => {
  let forkWork: string;
  let c3: string;

  beforeAll(() => {
    forkWork = join(tmp.path, "fork-work");
    git(tmp.path, ["clone", "-q", work, forkWork]);
    git(forkWork, ["checkout", "-q", "-b", "change", c2]);
    c3 = commitFiles(forkWork, { "src/big.txt": `${lorem(1, 300)}more\nand a fork change\n`, "fork.txt": lorem(5, 40) }, "c3");
  });

  function fork(): string {
    const name = `fork-${++repoCounter}`;
    git(forkWork, ["push", "-q", server.createBareRepo(name), "change"]);
    return name;
  }

  it("copies a change from a fork into refs/merge-queue/<id>, then fast-forwards main", async () => {
    const from = fork();
    const to = seededRepo(["feature:refs/heads/main"]); // target main = c2
    const rec = recordingFetch();
    const result = await transferObjects(server.remote(from, undefined, rec.fetch), server.remote(to), {
      sha: c3,
      toRef: "refs/merge-queue/42",
    });
    expect(result).toEqual({ ref: "refs/merge-queue/42", ok: true });
    const fetchBody = rec.calls.find((c) => c.url.endsWith("/git-upload-pack"))?.body ?? "";
    expect(fetchBody).toContain(`have ${c2}`);
    expect(fetchBody).toContain("ofs-delta");
    git(server.repoPath(to), ["fsck", "--full", "--strict"]);
    expect(git(server.repoPath(to), ["rev-parse", "refs/merge-queue/42"])).toBe(c3);
    await fastForward(server.remote(to), "refs/heads/main", c2, c3);
    expect(git(server.repoPath(to), ["rev-parse", "main"])).toBe(c3);
    // Already there: no second push.
    const again = recordingFetch();
    await transferObjects(server.remote(from), server.remote(to, undefined, again.fetch), { sha: c3, toRef: "refs/merge-queue/42" });
    expect(again.calls.some((c) => c.url.endsWith("/git-receive-pack"))).toBe(false);
  });

  it("requests REF_DELTA packs when the target does not advertise ofs-delta", async () => {
    const from = fork();
    const to = seededRepo(["main"], { "repack.usedeltabaseoffset": "false" });
    const target = await listRefs(server.remote(to), { service: "git-receive-pack" });
    expect(target.capabilities.has("ofs-delta")).toBe(false);
    const rec = recordingFetch();
    await transferObjects(server.remote(from, undefined, rec.fetch), server.remote(to), { sha: c3, toRef: "refs/merge-queue/43" });
    expect(rec.calls.find((c) => c.url.endsWith("/git-upload-pack"))?.body).not.toContain("ofs-delta");
    git(server.repoPath(to), ["fsck", "--full", "--strict"]);
    expect(git(server.repoPath(to), ["rev-parse", "refs/merge-queue/43"])).toBe(c3);
  });
});
