/**
 * Self-update, end to end: the bundled CLI (built fresh into a temp dir) run as a child process
 * against a local platform that serves /cli/version.json and a real `npm pack` tarball of a
 * newer build. The newer build is the same bundle plus one line that writes a marker to stderr,
 * so a run proves which build answered.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { selfUpdate, sha256, updateHost } from "../src/self-update.js";
import { tempDir } from "./support/io.js";

const root = join(import.meta.dirname, "..");
const work = tempDir("gittifacts-cli-self-update-");
/** The build a user has (stale). */
const stale = join(work, "bin", "cli.mjs");
const MARKER = "gittifacts-test: the newer build ran";

interface Platform {
  version: "ok" | "hang" | "404";
  doc: Record<string, unknown>;
  tarball: Buffer | "endless";
}
let platform: Platform;
let tarball: Buffer;
let newSha: string;
let newSize: number;
const requests: { path: string; headers: IncomingHttpHeaders }[] = [];
let server: Server;
let host: string;
let homes = 0;

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(
  args: string[],
  opts: {
    home: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
    stdin?: string;
    script?: string;
  },
): Promise<Result> {
  const cwd = opts.cwd ?? join(opts.home, "cwd");
  mkdirSync(cwd, { recursive: true });
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [opts.script ?? stale, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: opts.home,
        GITTIFACTS_CONFIG_DIR: join(opts.home, "config"),
        GITTIFACTS_TOKEN: "secret-token",
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(opts.stdin ?? "");
  });
}

function newHome(): string {
  const home = join(work, `home-${++homes}`);
  mkdirSync(home, { recursive: true });
  return home;
}

const cacheOf = (home: string) => join(home, ".cache", "gittifacts", "cli");
const hits = (path: string) => requests.filter((r) => r.path === path).length;
const VERSION = "/cli/version.json";
const TARBALL = "/cli/v2/gittifacts.tgz";

/** stdout is exactly one JSON document. */
function oneDocument(r: Result): Record<string, unknown> {
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

/** `npm pack` of a package whose dist/cli.mjs is `cli`: the platform's tarball format. */
function npmPack(cli: string, dir: string): Buffer {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "gittifacts", version: "0.1.0", bin: { gittifacts: "./dist/cli.mjs" } }),
  );
  copyFileSync(cli, join(dir, "dist", "cli.mjs"));
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", dir], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(work, "npm-cache") },
  });
  const [packed] = JSON.parse(out) as { filename: string }[];
  if (!packed) throw new Error("npm pack returned nothing");
  return readFileSync(join(dir, packed.filename));
}

beforeAll(async () => {
  execFileSync(process.execPath, ["build.mjs", "--outfile", stale], { cwd: root, stdio: "pipe" });
  const newer = join(work, "newer", "cli.mjs");
  mkdirSync(join(work, "newer"), { recursive: true });
  copyFileSync(stale, newer);
  // Runs after the CLI's top-level await, before its exit callback.
  appendFileSync(newer, `\nprocess.stderr.write(${JSON.stringify(`${MARKER}\n`)});\n`);
  const bytes = readFileSync(newer);
  newSha = sha256(bytes);
  newSize = bytes.length;
  tarball = npmPack(newer, join(work, "pack"));

  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    requests.push({ path, headers: req.headers });
    if (path === VERSION) {
      if (platform.version === "hang") return; // never answers
      if (platform.version === "404") return void res.writeHead(404).end("no");
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(platform.doc));
    }
    if (path === TARBALL) {
      res.writeHead(200, { "content-type": "application/gzip" });
      if (platform.tarball !== "endless") return void res.end(platform.tarball);
      // A hostile or broken platform: bytes forever, until the client hangs up.
      const chunk = Buffer.alloc(1024 * 1024, 7);
      const pump = () => {
        while (!res.destroyed && res.write(chunk));
        if (!res.destroyed) res.once("drain", pump);
      };
      res.on("close", () => requests.push({ path: "closed", headers: {} }));
      return pump();
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  platform = { version: "ok", doc: { sha256: newSha, size: newSize }, tarball };
});

describe("self-update from the platform", () => {
  it("runs the platform's newer build with the same argv, once, and caches it", async () => {
    const home = newHome();
    const r = await run(["--version"], { home, env: { GITTIFACTS_HOST: host } });
    expect(r.code).toBe(0);
    expect(oneDocument(r)).toEqual({ name: "gittifacts", version: "0.1.0" });
    // The newer build answered; nothing else on stderr (no terminal: no "updated" line).
    expect(r.stderr).toBe(`${MARKER}\n`);
    // No loop: the updated run never checks again.
    expect([hits(VERSION), hits(TARBALL)]).toEqual([1, 1]);
    // No token on either request.
    for (const req of requests) expect(req.headers.authorization).toBeUndefined();
    const cached = join(cacheOf(home), `${newSha}.mjs`);
    expect(sha256(readFileSync(cached))).toBe(newSha);
    expect(statSync(cacheOf(home)).mode & 0o777).toBe(0o700);
    // No temp files left behind.
    expect(readdirSync(cacheOf(home)).filter((f) => f.startsWith(".")).length).toBe(0);

    // Within 10 minutes: the cached build, no request at all.
    const again = await run(["--version"], { home, env: { GITTIFACTS_HOST: host } });
    expect(again.stderr).toBe(`${MARKER}\n`);
    expect(requests.length).toBe(2);

    // After the window: version.json again, but the cached file is reused (no download).
    for (const f of readdirSync(cacheOf(home)))
      if (f.startsWith("check-")) rmSync(join(cacheOf(home), f));
    const later = await run(["--version"], { home, env: { GITTIFACTS_HOST: host } });
    expect(later.stderr).toBe(`${MARKER}\n`);
    expect([hits(VERSION), hits(TARBALL)]).toEqual([2, 1]);

    // The guard itself: a run with GITTIFACTS_UPDATED=1 never checks, even with no stamp.
    const guarded = await run(["--version"], {
      home: newHome(),
      script: cached,
      env: { GITTIFACTS_HOST: host, GITTIFACTS_UPDATED: "1" },
    });
    expect(guarded.stderr).toBe(`${MARKER}\n`);
    expect(hits(VERSION)).toBe(2);
  });

  it("passes the newer build's exit code and its one JSON document through", async () => {
    const home = newHome();
    const r = await run(["no-such-command"], { home, env: { GITTIFACTS_HOST: host } });
    expect(r.stderr).toBe(`${MARKER}\n`);
    expect(r.code).toBe(2);
    expect(oneDocument(r)).toMatchObject({ error: { code: "usage" } });
  });

  it("never fetches from a host only the checkout's .gittifacts.json names", async () => {
    const home = newHome();
    const cwd = join(home, "checkout");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, ".gittifacts.json"), JSON.stringify({ host, projectId: "prj_1" }));
    const r = await run(["--version"], { home, cwd });
    expect(r.code).toBe(0);
    expect(oneDocument(r)).toEqual({ name: "gittifacts", version: "0.1.0" });
    expect(r.stderr).toBe("");
    expect(requests).toEqual([]);

    // The same file is trusted once the user logged in to that host from this machine.
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "credentials.json"),
      JSON.stringify({ version: 1, hosts: { [host]: { login: { token: "login-token" } } } }),
    );
    const trusted = await run(["--version"], { home, cwd });
    expect(trusted.stderr).toBe(`${MARKER}\n`);
    expect(hits(VERSION)).toBe(1);
    for (const req of requests) expect(req.headers.authorization).toBeUndefined();
  });

  it("skips the check for --no-update, GITTIFACTS_NO_UPDATE=1 and git-credential", async () => {
    const home = newHome();
    const env = { GITTIFACTS_HOST: host };
    const flag = await run(["--version", "--no-update"], { home, env });
    expect(oneDocument(flag)).toEqual({ name: "gittifacts", version: "0.1.0" });
    const variable = await run(["--version"], { home, env: { ...env, GITTIFACTS_NO_UPDATE: "1" } });
    expect(oneDocument(variable)).toEqual({ name: "gittifacts", version: "0.1.0" });
    const helper = await run(["git-credential", "get"], { home, env, stdin: "" });
    expect(helper.code).toBe(0);
    expect(helper.stdout).toBe("");
    expect([flag.stderr, variable.stderr, helper.stderr]).toEqual(["", "", ""]);
    expect(requests).toEqual([]);
  });

  it("lets git-credential run an already cached newer build, without fetching", async () => {
    const home = newHome();
    const env = { GITTIFACTS_HOST: host };
    await run(["--version"], { home, env });
    requests.length = 0;
    // Even with the check long overdue, the helper never asks the platform.
    for (const f of readdirSync(cacheOf(home))) {
      if (f.startsWith("check-")) {
        writeFileSync(join(cacheOf(home), f), JSON.stringify({ checkedAt: 0, sha256: newSha }));
      }
    }
    const helper = await run(["git-credential", "get"], { home, env, stdin: "" });
    expect(helper.code).toBe(0);
    expect(helper.stderr).toBe(`${MARKER}\n`);
    expect(requests).toEqual([]);
  });
});

describe("self-update failures run the CLI as it is", () => {
  it("a platform that never answers costs at most the 1.5 s timeout, once per 10 minutes", async () => {
    platform.version = "hang";
    const home = newHome();
    const r = await run(["--version"], { home, env: { GITTIFACTS_HOST: host } });
    expect(r.code).toBe(0);
    expect(oneDocument(r)).toEqual({ name: "gittifacts", version: "0.1.0" });
    expect(r.stderr).toBe("");
    expect(r.ms).toBeLessThan(1500 + 2500);
    const again = await run(["--version"], { home, env: { GITTIFACTS_HOST: host } });
    expect(again.code).toBe(0);
    expect(hits(VERSION)).toBe(1);
  });

  it("a platform that is down (connection refused) or answers 404 changes nothing", async () => {
    const down = await run(["--version"], {
      home: newHome(),
      env: { GITTIFACTS_HOST: "http://127.0.0.1:9" },
    });
    expect(down.code).toBe(0);
    expect(oneDocument(down)).toEqual({ name: "gittifacts", version: "0.1.0" });
    expect(down.stderr).toBe("");
    platform.version = "404";
    const missing = await run(["--version"], { home: newHome(), env: { GITTIFACTS_HOST: host } });
    expect(missing.code).toBe(0);
    expect(missing.stderr).toBe("");
    expect([hits(VERSION), hits(TARBALL)]).toEqual([1, 0]);
  });

  it("a tarball whose cli.mjs doesn't match version.json is never written or run", async () => {
    platform.doc = { sha256: "0".repeat(64), size: newSize };
    const home = newHome();
    const r = await run(["--version"], { home, env: { GITTIFACTS_HOST: host } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(hits(TARBALL)).toBe(1);
    expect(
      readdirSync(cacheOf(home)).filter((f) => f.endsWith(".mjs") || f.startsWith(".")),
    ).toEqual([]);
  });

  it("an endless tarball is cut off at the size cap", async () => {
    platform.tarball = "endless";
    const home = newHome();
    const r = await run(["--version"], { home, env: { GITTIFACTS_HOST: host } });
    expect(r.code).toBe(0);
    expect(oneDocument(r)).toEqual({ name: "gittifacts", version: "0.1.0" });
    expect(r.stderr).toBe("");
    expect(readdirSync(cacheOf(home)).filter((f) => f.endsWith(".mjs"))).toEqual([]);
    await expect.poll(() => hits("closed")).toBe(1);
  });

  it("malformed version.json (not 64 lowercase hex) is ignored", async () => {
    platform.doc = { sha256: newSha.toUpperCase(), size: newSize };
    const r = await run(["--version"], { home: newHome(), env: { GITTIFACTS_HOST: host } });
    expect(r.stderr).toBe("");
    expect(hits(TARBALL)).toBe(0);
  });
});

describe("self-update trust and output", () => {
  const base = { cwd: work, home: work };

  it("only fetches over https, or plain http to loopback", () => {
    const at = (h: string) => updateHost({ ...base, argv: ["--host", h], env: {} });
    expect(at("https://gf.example")).toBe("https://gf.example");
    expect(at("http://gf.example")).toBeNull();
    expect(at("http://10.0.0.7:8787")).toBeNull();
    expect(at("http://localhost:8787")).toBe("http://localhost:8787");
    expect(updateHost({ ...base, argv: [], env: { GITTIFACTS_HOST: "http://gf.example" } })).toBe(
      null,
    );
  });

  it("never calls fetch for a plain-http host, and tells a terminal it updated", async () => {
    const calls: string[] = [];
    const spy = (input: string, init?: RequestInit) => {
      calls.push(input);
      return fetch(input, init);
    };
    const stderr = { text: "", isTTY: true, write: (s: string) => (stderr.text += s) };
    const common = { argv: ["--version"], cwd: work, selfFile: stale, fetch: spy, stderr };
    const insecure = await selfUpdate({
      ...common,
      home: newHome(),
      env: { GITTIFACTS_HOST: "http://gf.example" },
      now: Date.now(),
    });
    expect(insecure).toBeNull();
    expect(calls).toEqual([]);

    const home = newHome();
    const file = await selfUpdate({
      ...common,
      home,
      env: { GITTIFACTS_HOST: host },
      now: Date.now(),
    });
    expect(file).toBe(join(cacheOf(home), `${newSha}.mjs`));
    expect(stderr.text).toBe(`gittifacts: updated to ${newSha.slice(0, 12)} from ${host}\n`);
    expect(existsSync(file ?? "")).toBe(true);
  });
});
