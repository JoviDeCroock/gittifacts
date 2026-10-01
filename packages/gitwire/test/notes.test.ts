import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type GitRemote,
  MemoryObjectStore,
  StaleRefError,
  fetchPack,
  listRefs,
  parsePack,
  readNote,
  writeNote,
} from "../src/index.js";
import { type GitHttpServer, startGitHttpServer } from "./support/git-http-server.js";
import { commitFiles, git, gitAsync, gitBytes, initRepo, tempDir } from "./support/git.js";

const TOKEN = "notes-token";
const NOTES = "refs/notes/evidence";
const author = { name: "gittifacts", email: "bot@gittifacts.dev", timestamp: 1700001000, timezone: "+0000" };

let server: GitHttpServer;
let tmp: { path: string; cleanup: () => void };
let work: string;
let c1: string;
let c2: string;
let c3: string;
let counter = 0;

function repo(config?: Record<string, string>): { name: string; path: string; remote: GitRemote } {
  const name = `notes-${++counter}`;
  const path = server.createBareRepo(name, config);
  git(work, ["push", "-q", path, "main"]);
  return { name, path, remote: server.remote(name) };
}

/** `git notes show` straight from the bare repo, as raw text. */
const gitNote = (path: string, sha: string) =>
  gitBytes(path, ["notes", "--ref=evidence", "show", sha]).toString("utf8");

/** Builds a notes commit from `path → content` using git plumbing only (for fanout fixtures). */
function gitNotesCommit(path: string, notes: Record<string, string>): string {
  const build = (entries: Array<[string[], string]>): string => {
    const groups = new Map<string, Array<[string[], string]>>();
    const lines: string[] = [];
    for (const [[head, ...rest], blob] of entries) {
      if (!rest.length) lines.push(`100644 blob ${blob}\t${head}`);
      else groups.set(head!, [...(groups.get(head!) ?? []), [rest, blob]]);
    }
    for (const [dir, sub] of groups) lines.push(`040000 tree ${build(sub)}\t${dir}`);
    return git(path, ["mktree"], { input: `${lines.join("\n")}\n` });
  };
  const entries = Object.entries(notes).map(([p, content]): [string[], string] => [
    p.split("/"),
    git(path, ["hash-object", "-w", "--stdin"], { input: content }),
  ]);
  return git(path, ["commit-tree", build(entries), "-m", "Notes added by 'git notes add'"]);
}

beforeAll(async () => {
  server = await startGitHttpServer({ token: TOKEN });
  tmp = tempDir();
  work = initRepo(join(tmp.path, "work"));
  c1 = commitFiles(work, { a: "1\n" }, "c1");
  c2 = commitFiles(work, { a: "2\n" }, "c2");
  c3 = commitFiles(work, { a: "3\n" }, "c3");
});

afterAll(async () => {
  await server.close();
  tmp.cleanup();
});

describe("writeNote / readNote", () => {
  it("creates the notes ref and git reads the note from a clone", async () => {
    const r = repo();
    const content = '{"format":"gittifacts.evidence/v1"}\n';
    const result = await writeNote(r.remote, { targetSha: c2, content, author, message: "evidence for c2\n" });
    expect(result).toMatchObject({ changed: true, attempts: 1 });
    expect(git(r.path, ["rev-parse", NOTES])).toBe(result.notesCommit);
    git(r.path, ["fsck", "--full", "--strict"]);
    expect(git(r.path, ["log", "-1", "--format=%an <%ae>|%P|%B", NOTES])).toBe("gittifacts <bot@gittifacts.dev>||evidence for c2");

    const clone = join(tmp.path, `clone-${counter}`);
    await gitAsync(tmp.path, [...server.gitAuthArgs(), "clone", "-q", server.url(r.name), clone]);
    await gitAsync(clone, [...server.gitAuthArgs(), "fetch", "-q", "origin", "refs/notes/*:refs/notes/*"]);
    expect(gitNote(clone, c2)).toBe(content);
    expect(await readNote(r.remote, NOTES, c2)).toBe(content);
  });

  it("replaces notes, chains commits and reads null for missing notes", async () => {
    const r = repo();
    expect(await readNote(r.remote, NOTES, c1)).toBeNull(); // no notes ref yet
    const first = await writeNote(r.remote, { targetSha: c1, content: "v1\n", author });
    const second = await writeNote(r.remote, { targetSha: c1, content: "v2\n", author });
    await writeNote(r.remote, { targetSha: c3, content: "other\n", author });
    expect(git(r.path, ["rev-parse", `${NOTES}~1`])).toBe(second.notesCommit);
    expect(git(r.path, ["rev-parse", `${NOTES}~2`])).toBe(first.notesCommit);
    expect(gitNote(r.path, c1)).toBe("v2\n");
    expect(await readNote(r.remote, NOTES, c1)).toBe("v2\n");
    expect(await readNote(r.remote, NOTES, c2)).toBeNull();
  });

  it("append matches `git notes append` byte for byte", async () => {
    const r = repo();
    await writeNote(r.remote, { targetSha: c1, content: "second\n", author, mode: "append" }); // no note yet
    await writeNote(r.remote, { targetSha: c1, content: "third\n", author, mode: "append" });

    const viaGit = repo();
    git(viaGit.path, ["notes", "--ref=evidence", "add", "-m", "second", c1]);
    git(viaGit.path, ["notes", "--ref=evidence", "append", "-m", "third", c1]);
    expect(gitNote(r.path, c1)).toBe(gitNote(viaGit.path, c1));
    expect(gitNote(r.path, c1)).toBe("second\n\nthird\n");
  });

  it("is a no-op when the note already has that content", async () => {
    const r = repo();
    const first = await writeNote(r.remote, { targetSha: c1, content: "same\n", author });
    const posts: string[] = [];
    const spy: typeof fetch = (input, init) => {
      if (init?.method === "POST") posts.push(String(input));
      return fetch(input, init);
    };
    const again = await writeNote({ ...r.remote, fetch: spy }, { targetSha: c1, content: "same\n", author });
    expect(again).toEqual({ notesCommit: first.notesCommit, changed: false, attempts: 1 });
    expect(posts.some((u) => u.endsWith("git-receive-pack"))).toBe(false);
  });

  it("reads and preserves fanout trees written by git", async () => {
    const r = repo();
    const [d1, rest1] = [c1.slice(0, 2), c1.slice(2)];
    const [d3a, d3b, rest3] = [c3.slice(0, 2), c3.slice(2, 4), c3.slice(4)];
    const tip = gitNotesCommit(r.path, { [`${d1}/${rest1}`]: "fanout note\n", [`${d3a}/${d3b}/${rest3}`]: "deep note\n" });
    git(r.path, ["update-ref", NOTES, tip]);
    expect(gitNote(r.path, c1)).toBe("fanout note\n"); // git agrees this is a valid fanout layout
    expect(await readNote(r.remote, NOTES, c1)).toBe("fanout note\n");
    expect(await readNote(r.remote, NOTES, c3)).toBe("deep note\n");

    await writeNote(r.remote, { targetSha: c2, content: "flat note\n", author });
    await writeNote(r.remote, { targetSha: c1, content: "more\n", author, mode: "append" });
    await writeNote(r.remote, { targetSha: c3, content: "deep v2\n", author });

    const paths = git(r.path, ["ls-tree", "-r", "--name-only", NOTES]).split("\n").sort();
    expect(paths).toEqual([`${d1}/${rest1}`, `${d3a}/${d3b}/${rest3}`, c2].sort());
    expect(gitNote(r.path, c1)).toBe("fanout note\n\nmore\n");
    expect(gitNote(r.path, c2)).toBe("flat note\n");
    expect(gitNote(r.path, c3)).toBe("deep v2\n");
    git(r.path, ["fsck", "--full", "--strict"]);
  });

  it("fetches the notes tree blobless and only the blob it needs", async () => {
    const r = repo();
    await writeNote(r.remote, { targetSha: c1, content: "a\n", author });
    await writeNote(r.remote, { targetSha: c2, content: "b\n", author });
    const bodies: string[] = [];
    const spy: typeof fetch = (input, init) => {
      if (String(input).endsWith("git-upload-pack") && init?.body instanceof Uint8Array) {
        bodies.push(Buffer.from(init.body).toString("latin1"));
      }
      return fetch(input, init);
    };
    expect(await readNote({ ...r.remote, fetch: spy }, NOTES, c2)).toBe("b\n");
    const fetches = bodies.filter((b) => b.includes("command=fetch"));
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).toContain("filter blob:none");
    expect(fetches[0]).toContain("deepen 1");
    expect(fetches[1]).toContain(`want ${git(r.path, ["rev-parse", `${NOTES}:${c2}`])}`);

    // Without filter support the snapshot includes blobs and still works.
    const plain = repo({ "uploadpack.allowFilter": "false" });
    await writeNote(plain.remote, { targetSha: c1, content: "x\n", author });
    await writeNote(plain.remote, { targetSha: c1, content: "y\n", author, mode: "append" });
    expect(gitNote(plain.path, c1)).toBe("x\n\ny\n");
  });

  it("retries after losing a compare-and-swap race", async () => {
    const r = repo();
    await writeNote(r.remote, { targetSha: c1, content: "base\n", author });
    let interfered = false;
    let races = 0;
    const racer: typeof fetch = async (input, init) => {
      if (!interfered && String(input).endsWith("git-receive-pack")) {
        interfered = true; // another writer lands first, between our read and our push
        await writeNote(r.remote, { targetSha: c2, content: races++ ? `racer ${races}\n` : "racer\n", author });
      }
      return fetch(input, init);
    };
    const result = await writeNote({ ...r.remote, fetch: racer }, { targetSha: c3, content: "mine\n", author });
    expect(result.attempts).toBe(2);
    expect([gitNote(r.path, c1), gitNote(r.path, c2), gitNote(r.path, c3)]).toEqual(["base\n", "racer\n", "mine\n"]);

    // With retries disabled the lost race surfaces as StaleRefError.
    interfered = false;
    await expect(
      writeNote({ ...r.remote, fetch: racer }, { targetSha: c3, content: "again\n", author, maxRetries: 0 }),
    ).rejects.toBeInstanceOf(StaleRefError);
  });

  it("serialises truly concurrent writers via CAS", async () => {
    const r = repo();
    const targets = [c1, c2, c3];
    const results = await Promise.all(
      targets.map((targetSha) => writeNote(r.remote, { targetSha, content: `note ${targetSha}\n`, author, maxRetries: 6 })),
    );
    expect(results.every((x) => x.changed)).toBe(true);
    for (const t of targets) expect(gitNote(r.path, t)).toBe(`note ${t}\n`);
    expect(git(r.path, ["rev-list", "--count", NOTES])).toBe("3");
  });

  it("reads through any ObjectReader (the seam for the Artifacts binding)", async () => {
    const r = repo();
    await writeNote(r.remote, { targetSha: c2, content: "via reader\n", author });
    const tip = (await listRefs(r.remote)).get(NOTES)!;
    const store = new MemoryObjectStore(await parsePack(await fetchPack(r.remote, { wants: [tip] })), new Map([[NOTES, tip]]));
    expect(await readNote(store, NOTES, c2)).toBe("via reader\n");
    expect(await readNote(store, "refs/notes/other", c2)).toBeNull();
  });
});
