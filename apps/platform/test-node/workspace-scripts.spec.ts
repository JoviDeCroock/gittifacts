/**
 * The workspace's container scripts (src/workspace/scripts.ts), run for real with sh + git + node
 * against a temp checkout (`WS_ROOT`) and a local bare "fork" (the workerd tests fake the machine).
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHECKOUT_SCRIPT,
  COMMIT_PUSH_SCRIPT,
  DIFF_STAT_SCRIPT,
  lastWsMarker,
  PATCH_SCRIPT,
  parseDiffStats,
  READ_SCRIPT,
  WRITE_SCRIPT,
  workspaceTokenEnv,
} from "../src/workspace/scripts.js";

const tmp = mkdtempSync(join(tmpdir(), "gittifacts-ws-"));
const remote = join(tmp, "fork.git");
const root = join(tmp, "workspace");
const ENV = {
  PATH: process.env.PATH ?? "",
  HOME: tmp,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "agent",
  GIT_AUTHOR_EMAIL: "ag@principals.gittifacts.dev",
  GIT_COMMITTER_NAME: "agent",
  GIT_COMMITTER_EMAIL: "ag@principals.gittifacts.dev",
  WS_ROOT: root,
  WS_REMOTE: `file://${remote}`,
  WS_BRANCH: "main",
  // The token travels like in production (env-only header); file:// ignores it.
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: "Authorization: Bearer tok",
};
let base = "";
let head = "";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: ENV,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function sh(script: string, args: string[] = [], env: Record<string, string> = {}, input?: string) {
  const r = spawnSync("sh", ["-c", script, "gittifacts-ws", ...args], {
    cwd: root,
    env: { ...ENV, ...env },
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  const seed = join(tmp, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q");
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "base");
  base = git(seed, "rev-parse", "HEAD");
  writeFileSync(join(seed, "a.txt"), "one\ntwo\n");
  git(seed, "commit", "-q", "-am", "head");
  head = git(seed, "rev-parse", "HEAD");
  git(tmp, "clone", "-q", "--bare", seed, remote);
  git(remote, "config", "uploadpack.allowFilter", "true");
  mkdirSync(root);
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("workspace scripts", () => {
  it("checks out the fork's head on its branch, with the base available", () => {
    const r = sh(CHECKOUT_SCRIPT, [], { WS_HEAD: head, WS_BASE: base });
    expect(r.code, r.stderr).toBe(0);
    expect(lastWsMarker(r.stdout)).toEqual({ head });
    expect(git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(root, "cat-file", "-t", base)).toBe("commit");
    expect(readFileSync(join(root, ".git", "config"), "utf8")).not.toContain("tok");
  });

  it("reads and writes inside the checkout only (symlinks resolved)", () => {
    expect(sh(READ_SCRIPT, ["a.txt", "100"]).stdout).toBe("one\ntwo\n");
    symlinkSync("/etc", join(root, "etc-link"));
    for (const p of ["../outside", "etc-link/hosts", ".git/config"]) {
      expect(sh(READ_SCRIPT, [p, "100"]).code, p).toBe(3);
      expect(sh(WRITE_SCRIPT, [p], {}, "x").code, p).toBe(3);
    }
    expect(sh(READ_SCRIPT, ["missing.txt", "100"]).code).toBe(4);
    const w = sh(WRITE_SCRIPT, ["src/new/b.txt"], {}, "bee\n");
    expect(w.code, w.stderr).toBe(0);
    expect(lastWsMarker(w.stdout)).toEqual({ created: true });
    rmSync(join(root, "etc-link"));
  });

  it("applies a patch to one file and refuses patches that touch others", () => {
    const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
    const r = sh(PATCH_SCRIPT, ["a.txt"], {}, patch);
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\nTWO\n");
    expect(sh(PATCH_SCRIPT, ["src/new/b.txt"], {}, patch.replaceAll("TWO", "2")).code).toBe(6);
  });

  it("diffs everything (untracked included) against the base", () => {
    const r = sh(DIFF_STAT_SCRIPT, [], { WS_BASE: base });
    expect(r.code, r.stderr).toBe(0);
    expect(parseDiffStats(r.stdout)).toEqual([
      { path: "a.txt", status: "modified", additions: 1, deletions: 0 },
      { path: "src/new/b.txt", status: "added", additions: 1, deletions: 0 },
    ]);
  });

  it("commits as the agent and pushes to the fork, ignoring injected git config", () => {
    // Repo code could redirect the push (and its token) with a url rewrite: the script resets it.
    git(root, "config", `url.file://${join(tmp, "elsewhere.git")}.insteadOf`, `file://${remote}`);
    const r = sh(COMMIT_PUSH_SCRIPT, [], { WS_MESSAGE: "fix: two", WS_PUSHED: head });
    expect(r.code, r.stderr).toBe(0);
    const m = lastWsMarker(r.stdout) as { status: string; head: string; files: number };
    expect(m).toMatchObject({ status: "pushed", files: 2 });
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(m.head);
    expect(git(remote, "log", "-1", "--format=%an <%ae>", "main")).toBe(
      "agent <ag@principals.gittifacts.dev>",
    );
    expect(
      lastWsMarker(sh(COMMIT_PUSH_SCRIPT, [], { WS_MESSAGE: "again", WS_PUSHED: m.head }).stdout),
    ).toEqual({ status: "nothing", head: m.head });
  });

  it("reports a rejected push when the fork moved", () => {
    const other = join(tmp, "other");
    git(tmp, "clone", "-q", remote, other);
    writeFileSync(join(other, "c.txt"), "c\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "elsewhere");
    git(other, "push", "-q", "origin", "HEAD:main");
    writeFileSync(join(root, "d.txt"), "d\n");
    const pushed = git(root, "rev-parse", "HEAD");
    const r = sh(COMMIT_PUSH_SCRIPT, [], { WS_MESSAGE: "late", WS_PUSHED: pushed });
    expect(lastWsMarker(r.stdout)).toMatchObject({ status: "rejected" });
  });

  it("runs nothing repo code planted in ~/.gitconfig or .git while the token is in env", () => {
    // Security audit 2026-10-11 (Low): the machine's token env alone must keep git from reading
    // global config, hooks and fsmonitor; the base ENV here (GIT_CONFIG_GLOBAL) is left out.
    const home = join(tmp, "planted-home");
    const marker = join(tmp, "PWNED");
    const evil = join(tmp, "evil.sh");
    mkdirSync(home);
    writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> ${marker}\nexit 1\n`);
    chmodSync(evil, 0o755);
    const hooks = join(tmp, "planted-hooks");
    mkdirSync(hooks);
    for (const hook of ["post-checkout", "pre-commit", "pre-push", "reference-transaction"]) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\n${evil} ${hook}\n`);
      chmodSync(join(hooks, hook), 0o755);
    }
    writeFileSync(
      join(home, ".gitconfig"),
      `[core]\n\tfsmonitor = ${evil}\n\thooksPath = ${hooks}\n[credential]\n\thelper = !${evil}\n`,
    );
    git(root, "config", "core.fsmonitor", evil);
    const isolated = (script: string, env: Record<string, string>) => {
      const r = spawnSync("sh", ["-c", script, "gittifacts-ws"], {
        cwd: root,
        env: {
          PATH: ENV.PATH,
          HOME: home,
          GIT_AUTHOR_NAME: ENV.GIT_AUTHOR_NAME,
          GIT_AUTHOR_EMAIL: ENV.GIT_AUTHOR_EMAIL,
          GIT_COMMITTER_NAME: ENV.GIT_COMMITTER_NAME,
          GIT_COMMITTER_EMAIL: ENV.GIT_COMMITTER_EMAIL,
          WS_ROOT: root,
          WS_REMOTE: ENV.WS_REMOTE,
          WS_BRANCH: ENV.WS_BRANCH,
          ...workspaceTokenEnv("tok"),
          ...env,
        },
        encoding: "utf8",
      });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    const tip = git(remote, "rev-parse", "refs/heads/main");
    const co = isolated(CHECKOUT_SCRIPT, { WS_HEAD: tip, WS_BASE: base });
    expect(co.code, co.stderr).toBe(0);
    expect(readFileSync(join(root, ".git", "config"), "utf8")).not.toContain("fsmonitor");
    git(root, "config", "core.fsmonitor", evil);
    writeFileSync(join(root, "e.txt"), "e\n");
    const push = isolated(COMMIT_PUSH_SCRIPT, { WS_MESSAGE: "planted", WS_PUSHED: tip });
    expect(push.code, push.stderr).toBe(0);
    expect(lastWsMarker(push.stdout)).toMatchObject({ status: "pushed" });
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });
});
