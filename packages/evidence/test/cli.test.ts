import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runKeygen } from "../src/cli/run-keygen.js";
import { runVerify } from "../src/cli/run-verify.js";
import {
  type EvidencePayload,
  encodeNote,
  generateSigningKey,
  type SigningKeyPair,
  signEvidence,
} from "../src/index.js";
import { readNote, resolveCommit, writeNote } from "../src/node/index.js";
import { sampleItems } from "./helpers.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..", "..");

let tmp: string;
let repo: string;
let head: string;
let parent: string;
let key: SigningKeyPair;
let other: SigningKeyPair;

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf8",
    env: gitEnv,
  }).trim();
}

async function signedNote(headSha: string, mutate?: (p: EvidencePayload) => void): Promise<string> {
  const payload: EvidencePayload = { changeId: "chg_cli", headSha, items: sampleItems() };
  mutate?.(payload);
  const signer = { privateKey: key.privateKey, publicKey: key.publicKey, name: "gittifacts-ci" };
  return encodeNote(await signEvidence(payload, signer, { now: new Date("2026-10-01T12:00:00Z") }));
}

function attach(commit: string, note: string, extra: string[] = []): void {
  const file = join(tmp, "note.json");
  writeFileSync(file, note);
  git("notes", "--ref=refs/notes/evidence", "add", ...extra, "-F", file, commit);
}

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runVerify(argv, {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
  });
  return { code, out, err };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "gittifacts-evidence-"));
  repo = join(tmp, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  parent = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "a.txt"), "two\n");
  git("commit", "-q", "-am", "second");
  head = git("rev-parse", "HEAD");
  key = await generateSigningKey();
  other = await generateSigningKey();
  attach(head, await signedNote(head));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("verify-attestation (in-process)", () => {
  it("verifies a signed note on a commit", async () => {
    const r = await run("--repo", repo, "--commit", "HEAD", "--public-key", key.publicKey);
    expect(r.code).toBe(0);
    expect(r.out).toContain("verdict   VERIFIED");
    expect(r.out).toContain(`commit    ${head}`);
    expect(r.out).toContain("change    chg_cli");
    expect(r.out).toContain(`key ${key.keyId}`);
    expect(r.out).toMatch(/ok\s+red-green\s+proven \(1 test\)/);
    expect(r.out).toMatch(/ok\s+coverage\s+75% of 4 changed executable lines covered/);
    expect(r.out).toMatch(/error\s+mutation\s+measurement failed: stryker crashed/);
    expect(r.out).toContain("1 item(s) not measured");
  });

  it("emits JSON with --json", async () => {
    const r = await run("--repo", repo, "--commit", head, "--public-key", key.publicKey, "--json");
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(j).toMatchObject({
      ok: true,
      commit: head,
      headSha: head,
      keyId: key.keyId,
      bindingChecked: true,
    });
    expect((j.items as unknown[]).length).toBe(4);
  });

  it("verifies against a key set file (rotation)", async () => {
    const keysFile = join(tmp, "keys.json");
    writeFileSync(
      keysFile,
      JSON.stringify({
        keys: [
          { publicKey: other.publicKey, name: "next" },
          {
            keyId: key.keyId,
            publicKey: key.publicKey,
            name: "2026",
            notAfter: "2027-01-01T00:00:00Z",
          },
        ],
      }),
    );
    const r = await run("--repo", repo, "--commit", head, "--keys", keysFile);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(2026)");

    writeFileSync(
      keysFile,
      JSON.stringify([{ publicKey: key.publicKey, notAfter: "2026-01-01T00:00:00Z" }]),
    );
    const expired = await run("--repo", repo, "--commit", head, "--keys", keysFile);
    expect(expired.code).toBe(1);
    expect(expired.out).toContain("NOT VERIFIED (expired-key)");
  });

  it("fetches a key set from --keys-url (https only)", async () => {
    let seen = "";
    let out = "";
    const code = await runVerify(
      ["--repo", repo, "--commit", head, "--keys-url", "https://keys.example/evidence.json"],
      {
        stdout: (s) => {
          out += s;
        },
        stderr: () => {},
        fetch: async (input) => {
          seen = String(input);
          return new Response(JSON.stringify({ keys: [{ publicKey: key.publicKey }] }), {
            status: 200,
          });
        },
      },
    );
    expect(code).toBe(0);
    expect(seen).toBe("https://keys.example/evidence.json");
    expect(out).toContain("VERIFIED");
    const insecure = await run(
      "--repo",
      repo,
      "--commit",
      head,
      "--keys-url",
      "http://keys.example/k.json",
    );
    expect(insecure.code).toBe(2);
    expect(insecure.err).toContain("must use https");
  });

  it("fails with the wrong key", async () => {
    const r = await run("--repo", repo, "--commit", head, "--public-key", other.publicKey);
    expect(r.code).toBe(1);
    expect(r.out).toContain("NOT VERIFIED (unknown-key)");
    expect(r.out).toContain("UNVERIFIED, do not trust");
  });

  it("fails when there is no note, or the commit does not exist", async () => {
    const none = await run("--repo", repo, "--commit", parent, "--public-key", key.publicKey);
    expect(none.code).toBe(1);
    expect(none.out).toContain("NOT VERIFIED (no-note)");
    const missing = await run(
      "--repo",
      repo,
      "--commit",
      "deadbeef",
      "--public-key",
      key.publicKey,
    );
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("unknown-commit");
  });

  it("fails when the note is bound to a different commit", async () => {
    attach(parent, await signedNote(head));
    const r = await run("--repo", repo, "--commit", parent, "--public-key", key.publicKey);
    expect(r.code).toBe(1);
    expect(r.out).toContain("NOT VERIFIED (commit-mismatch)");
    expect(r.out).toContain("MISMATCH");
    git("notes", "--ref=refs/notes/evidence", "remove", parent);
  });

  it("fails after the note is tampered with, and recovers when restored", async () => {
    const original = git("notes", "--ref=refs/notes/evidence", "show", head);
    const tampered = original.replace('"ratio": 0.75', '"ratio": 1');
    expect(tampered).not.toBe(original);
    attach(head, tampered, ["-f"]);
    const r = await run("--repo", repo, "--commit", head, "--public-key", key.publicKey);
    expect(r.code).toBe(1);
    expect(r.out).toContain("NOT VERIFIED (digest-mismatch)");
    attach(head, `${original}\n`, ["-f"]);
    expect((await run("--repo", repo, "--commit", head, "--public-key", key.publicKey)).code).toBe(
      0,
    );
  });

  it("uses the last document of an appended note", async () => {
    const note = await signedNote(head, (p) => {
      p.items = p.items.slice(0, 1);
    });
    const file = join(tmp, "append.json");
    writeFileSync(file, note);
    git("notes", "--ref=refs/notes/evidence", "append", "-F", file, head);
    const text = git("notes", "--ref=refs/notes/evidence", "show", head);
    expect(text.split('"format"').length - 1).toBe(2);
    const r = await run("--repo", repo, "--commit", head, "--public-key", key.publicKey, "--json");
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as { items: unknown[] }).items).toHaveLength(1);
    // appending a forged document makes the commit fail, not fall back to the older one
    writeFileSync(file, note.replace("chg_cli", "chg_forged"));
    git("notes", "--ref=refs/notes/evidence", "append", "-F", file, head);
    expect((await run("--repo", repo, "--commit", head, "--public-key", key.publicKey)).code).toBe(
      1,
    );
    attach(head, await signedNote(head), ["-f"]);
  });

  it("--file mode, with and without a commit binding", async () => {
    const file = join(tmp, "standalone.json");
    writeFileSync(file, await signedNote(head));
    const bound = await run("--file", file, "--commit", head, "--public-key", key.publicKey);
    expect(bound.code).toBe(0);
    const unbound = await run("--file", file, "--public-key", key.publicKey);
    expect(unbound.code).toBe(0);
    expect(unbound.out).toContain("commit binding not checked");
    const wrong = await run("--file", file, "--commit", parent, "--public-key", key.publicKey);
    expect(wrong.code).toBe(1);
    writeFileSync(file, "not json at all");
    const junk = await run("--file", file, "--public-key", key.publicKey);
    expect(junk.code).toBe(1);
    expect(junk.out).toContain("bad-note");
    writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(await signedNote(head)), format: "other/v9" }),
    );
    expect((await run("--file", file, "--public-key", key.publicKey)).out).toContain(
      "NOT VERIFIED (schema)",
    );
  });

  it("usage errors exit 2", async () => {
    expect((await run("--repo", repo, "--commit", head)).code).toBe(2);
    expect(
      (await run("--repo", repo, "--commit", head, "--public-key", "x", "--keys", "y")).code,
    ).toBe(2);
    expect((await run("--commit", head, "--public-key", key.publicKey, "--bogus")).code).toBe(2);
    expect((await run("--public-key", key.publicKey)).code).toBe(2);
    expect(
      (await run("--repo", repo, "--commit", "--upload-pack=x", "--public-key", key.publicKey))
        .code,
    ).toBe(2);
    expect(
      (await run("--repo", repo, "--commit", head, "--keys", join(tmp, "nope.json"))).code,
    ).toBe(2);
    const help = await run("--help");
    expect(help.code).toBe(0);
    expect(help.err).toContain("Usage:");
  });
});

describe("node helpers", () => {
  it("writeNote/readNote/resolveCommit round-trip", async () => {
    expect(await resolveCommit(repo, "HEAD~1")).toBe(parent);
    expect(await resolveCommit(repo, "nope")).toBeNull();
    await expect(resolveCommit(repo, "-x")).rejects.toThrow(/suspicious/);
    await writeNote(repo, parent, "hello\n", { ref: "refs/notes/test" });
    expect(await readNote(repo, parent, "refs/notes/test")).toBe("hello\n");
    expect(await readNote(repo, head, "refs/notes/test")).toBeNull();
    await expect(readNote(repo, head, "refs/heads/main")).rejects.toThrow(/refs\/notes/);
  });
});

describe("keygen", () => {
  it("prints a usable key pair as JSON", async () => {
    let out = "";
    let err = "";
    const code = await runKeygen(
      ["--name", "ci-2026"],
      {
        stdout: (s) => {
          out += s;
        },
        stderr: (s) => {
          err += s;
        },
      },
      new Date("2026-10-01T00:00:00Z"),
    );
    expect(code).toBe(0);
    const k = JSON.parse(out) as SigningKeyPair & { alg: string; createdAt: string; name: string };
    expect(k).toMatchObject({
      alg: "Ed25519",
      createdAt: "2026-10-01T00:00:00.000Z",
      name: "ci-2026",
    });
    expect(err).toContain("wrangler secret put");
    // the printed key actually signs verifiable evidence
    const s = await signEvidence(
      { changeId: "c", headSha: head, items: [] },
      { privateKey: k.privateKey, publicKey: k.publicKey, name: "k" },
    );
    expect(s.attestation.keyId).toBe(k.keyId);
  });
});

describe("standalone execution", () => {
  it("runs via tsx (the root `pnpm verify-attestation` script) with real exit codes", () => {
    const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
    const cli = join(pkgRoot, "src", "cli", "verify.ts");
    const ok = spawnSync(
      tsx,
      [cli, "--repo", repo, "--commit", head, "--public-key", key.publicKey],
      {
        encoding: "utf8",
      },
    );
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("VERIFIED");
    const bad = spawnSync(
      tsx,
      [cli, "--repo", repo, "--commit", head, "--public-key", other.publicKey],
      {
        encoding: "utf8",
      },
    );
    expect(bad.status).toBe(1);
  });

  it("bundles to a single file that runs with plain node", () => {
    const out = join(tmp, "dist");
    const build = spawnSync(process.execPath, [join(pkgRoot, "scripts", "build-cli.mjs"), out], {
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);
    const bundle = join(out, "verify-attestation.mjs");
    expect(readFileSync(bundle, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
    const r = spawnSync(
      process.execPath,
      [bundle, "--repo", repo, "--commit", head, "--public-key", key.publicKey],
      {
        encoding: "utf8",
        cwd: tmp, // no node_modules anywhere near
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("VERIFIED");
  });
});
