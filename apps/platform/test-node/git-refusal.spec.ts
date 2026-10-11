/**
 * A real `git push` against the read-only proxy's refusal (src/integrations/git-refusal.ts): git
 * must print the push-to-main fix as `remote:` lines, not a bare "returned error: 403".
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { receivePackRefusal } from "../src/integrations/git-refusal.js";

const tmp = mkdtempSync(join(tmpdir(), "gittifacts-refusal-"));
const ENV = {
  PATH: process.env.PATH ?? "",
  HOME: tmp,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "agent",
  GIT_AUTHOR_EMAIL: "ag@example.test",
  GIT_COMMITTER_NAME: "agent",
  GIT_COMMITTER_EMAIL: "ag@example.test",
};
let server: Server;
let base = "";
const seen: string[] = [];

function git(args: string[], cwd = tmp) {
  return spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });
}

/** Async: the HTTP server answering it runs on this same event loop. */
function push(url: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((ok) => {
    const p = spawn("git", ["push", url, "HEAD:main"], { cwd: join(tmp, "work"), env: ENV });
    let stderr = "";
    p.stderr.on("data", (d) => {
      stderr += String(d);
    });
    p.on("close", (status) => ok({ status, stderr }));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const url = new URL(req.url ?? "/", "http://x");
    const changeId = /\/changes\/([^/.]+)\.git\//.exec(url.pathname)?.[1] ?? null;
    const r = receivePackRefusal({ host: "https://gittifacts.test", changeId });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(await r.text());
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  git(["init", "-q", "-b", "main", "work"]);
  writeFileSync(join(tmp, "work", "a.txt"), "a\n");
  git(["add", "."], join(tmp, "work"));
  git(["commit", "-q", "-m", "a"], join(tmp, "work"));
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  rmSync(tmp, { recursive: true, force: true });
});

describe("git push to the read-only proxy", () => {
  it("shows the push-to-main fix as remote: lines", async () => {
    const r = await push(`${base}/git/acme/api.git`);
    expect(r.status).not.toBe(0);
    expect(seen[0]).toBe("GET /git/acme/api.git/info/refs?service=git-receive-pack");
    expect(r.stderr).toContain("remote: gittifacts: push refused (push-to-main).");
    expect(r.stderr).toContain("remote: Only the merge queue writes main.");
    expect(r.stderr).toContain('remote: Fix: start_change({ repoId: "<repoId>"');
    expect(r.stderr).toContain("remote: Then: git -c http.extraHeader=");
    expect(r.stderr).toContain("remote: Docs: https://gittifacts.test/start");
  });

  it("on a Change's read-only path, points at the fork's push token", async () => {
    const r = await push(`${base}/git/acme/api/changes/ch-1.git`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('remote: Fix: refresh_push_token({ changeId: "ch-1" })');
  });
});
