/**
 * The Runner's CHECKOUT_SCRIPT run for real with sh + git against a temp workspace and a local
 * bare remote, with the env the Runner gives it (`checkoutEnv`). The workerd suite fakes the
 * container, so this is where the script itself is exercised. Security audit 2026-10-11 (H3, Low):
 * a snapshot carries `.git/config`, hooks and `~/.gitconfig` written by repository code, and the
 * checkout exec holds the token.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECKOUT_SCRIPT, checkoutEnv, WORKSPACE } from "../../src/runner/shell.js";

const tmp = mkdtempSync(join(tmpdir(), "gittifacts-checkout-"));
const remote = join(tmp, "remote.git");
const ws = join(tmp, "workspace");
const home = join(tmp, "home");
const marker = join(tmp, "PWNED");
const script = CHECKOUT_SCRIPT.replaceAll(WORKSPACE, ws);
const SEED_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: tmp,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const shas: Record<"base" | "head" | "head2", string> = { base: "", head: "", head2: "" };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: SEED_ENV,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function checkout(headSha: string, opts: { restoreTracked?: boolean } = {}) {
  const env = {
    PATH: process.env.PATH ?? "",
    ...checkoutEnv({
      remote: `file://${remote}`,
      headSha,
      baseSha: shas.base,
      token: "tok",
      ...opts,
    }),
    // Where a parent step's repository code could have written ~/.gitconfig.
    HOME: home,
  };
  return spawnSync("sh", ["-c", script], { cwd: tmp, env, encoding: "utf8" });
}

beforeAll(() => {
  const seed = join(tmp, "seed");
  mkdirSync(seed);
  mkdirSync(home);
  git(seed, "init", "-q");
  writeFileSync(join(seed, "a.txt"), "base\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "base");
  shas.base = git(seed, "rev-parse", "HEAD");
  writeFileSync(join(seed, "a.txt"), "head\n");
  git(seed, "commit", "-q", "-am", "head");
  shas.head = git(seed, "rev-parse", "HEAD");
  writeFileSync(join(seed, "a.txt"), "head2\n");
  git(seed, "commit", "-q", "-am", "head2");
  shas.head2 = git(seed, "rev-parse", "HEAD");
  git(tmp, "clone", "-q", "--bare", seed, remote);
  git(remote, "config", "uploadpack.allowFilter", "true");
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** What a hostile install step leaves in the snapshot: config, hooks, ~/.gitconfig, edits. */
function plant(): void {
  const evil = join(tmp, "evil.sh");
  writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> ${marker}\nexit 1\n`);
  chmodSync(evil, 0o755);
  const cfg = join(ws, ".git", "config");
  writeFileSync(
    cfg,
    `${readFileSync(cfg, "utf8")}[core]\n\tfsmonitor = ${evil}\n[credential]\n\thelper = !${evil}\n` +
      `[url "file://${join(tmp, "nowhere.git")}"]\n\tinsteadOf = file://${remote}\n`,
  );
  mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
  writeFileSync(join(ws, ".git", "hooks", "post-checkout"), `#!/bin/sh\n${evil} hook\n`);
  chmodSync(join(ws, ".git", "hooks", "post-checkout"), 0o755);
  writeFileSync(
    join(home, ".gitconfig"),
    `[core]\n\tfsmonitor = ${evil}\n\thooksPath = ${join(ws, ".git", "hooks")}\n`,
  );
  writeFileSync(join(ws, "a.txt"), "rewritten by a postinstall\n");
  mkdirSync(join(ws, "node_modules"), { recursive: true });
  writeFileSync(join(ws, "node_modules", "dep.js"), "1");
}

describe("CHECKOUT_SCRIPT", () => {
  it("checks out a fresh workspace with the base commit's blobs", () => {
    const r = checkout(shas.head);
    expect(r.status, r.stderr).toBe(0);
    expect(git(ws, "rev-parse", "HEAD")).toBe(shas.head);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("head\n");
    expect(git(ws, "show", `${shas.base}:a.txt`)).toBe("base");
  });

  it("runs nothing a snapshot planted, and rewrites .git/config, when moving to a new commit", () => {
    plant();
    const r = checkout(shas.head2);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
    expect(git(ws, "rev-parse", "HEAD")).toBe(shas.head2);
    const config = readFileSync(join(ws, ".git", "config"), "utf8");
    expect(config).not.toMatch(/fsmonitor|insteadOf|helper/);
    expect(config).toContain(`url = file://${remote}`);
    expect(existsSync(join(ws, "node_modules", "dep.js"))).toBe(true);
  });

  it("evidence steps put tracked files back to HEAD over a same-commit snapshot; user steps keep them", () => {
    plant();
    const user = checkout(shas.head2);
    expect(user.status, user.stderr).toBe(0);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("rewritten by a postinstall\n");
    const evidence = checkout(shas.head2, { restoreTracked: true });
    expect(evidence.status, evidence.stderr).toBe(0);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("head2\n");
    expect(existsSync(join(ws, "node_modules", "dep.js"))).toBe(true);
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
  });
});
