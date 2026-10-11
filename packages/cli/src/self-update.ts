/**
 * The CLI updates itself from the platform it trusts. npx reuses its install for a tarball URL it
 * has seen (and never refetches it), so without this an `npx -y <host>/cli/v2/gittifacts.tgz`
 * user would keep their first build forever.
 *
 * Before dispatch (src/cli.ts):
 * 1. Pick the host: `--host`, `GITTIFACTS_HOST`, a host the user logged in to or created a project
 *    on (the credentials file has it), the last login, the build default. Never a host only a
 *    checkout's `.gittifacts.json` names (security audit H2): that file can point anywhere, and
 *    this fetches code to run. `https:` only; plain `http:` only to loopback (host-trust.ts).
 * 2. At most every 10 minutes per host (a stamp file), GET `<host>/cli/version.json` (1.5 s, no
 *    token, no redirects). When its sha256 differs from this file's and no cached copy exists,
 *    download `<host>/cli/v2/gittifacts.tgz` (capped at 20 MB while streaming), gunzip it, take
 *    `package/dist/cli.mjs`, check its sha256 and size against version.json, and only then write
 *    it (temp file + rename) to `~/.cache/gittifacts/cli/<sha256>.mjs` (a 0700 directory).
 * 3. Run that file with the same argv, stdio inherited, `GITTIFACTS_UPDATED=1` so it never checks
 *    again, and pass its exit code through.
 *
 * Any failure (offline, a timeout, bad JSON, a hash mismatch, a full disk) runs this CLI as it is.
 * Nothing goes to stdout (the JSON contract is one document); one stderr line on a terminal.
 * `git-credential` never fetches (git waits on it): it only runs an already cached newer build.
 * Opt out with `--no-update` or `GITTIFACTS_NO_UPDATE=1`.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as z from "zod/mini";
import { credentialsPath, findProject, readCredentials, resolveHost } from "./config.js";
import { isSecureOrigin } from "./host-trust.js";
import type { Writer } from "./io.js";

type Env = Readonly<Record<string, string | undefined>>;

export const VERSION_PATH = "/cli/version.json";
export const TARBALL_PATH = "/cli/v2/gittifacts.tgz";
/** Set on the re-executed build: it must not check (or update) again. */
export const UPDATED_ENV = "GITTIFACTS_UPDATED";
export const CHECK_EVERY_MS = 10 * 60 * 1000;
export const VERSION_TIMEOUT_MS = 1500;
export const DOWNLOAD_TIMEOUT_MS = 15_000;
export const MAX_TARBALL_BYTES = 20 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAX_VERSION_BYTES = 64 * 1024;
const BUNDLE_ENTRY = "package/dist/cli.mjs";

// zod/mini: the functional API tree-shakes, so the bundle stays small.
const Sha256 = z.string().check(z.regex(/^[0-9a-f]{64}$/));

/** `/cli/version.json` (packages/cli/scripts/pack-assets.mjs). Untrusted input. */
export const VersionDoc = z.object({
  sha256: Sha256,
  size: z.int().check(z.positive(), z.maximum(MAX_UNPACKED_BYTES)),
  version: z.optional(z.string().check(z.maxLength(64))),
  builtAt: z.optional(z.string().check(z.maxLength(64))),
});
export type VersionDoc = z.infer<typeof VersionDoc>;

const Stamp = z.object({ checkedAt: z.number(), sha256: z.nullable(Sha256) });
type Stamp = z.infer<typeof Stamp>;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface UpdateOptions {
  argv: readonly string[];
  env: Env;
  cwd: string;
  home: string;
  /** This CLI's own file (dist/cli.mjs, or a cached build). */
  selfFile: string;
  fetch: FetchFn;
  now: number;
  stderr: Writer;
}

/** `--host <v>` / `--host=<v>` and `--no-update`, before any `--`. */
export function updateFlags(argv: readonly string[]): { host?: string; noUpdate: boolean } {
  let host: string | undefined;
  let noUpdate = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] ?? "";
    if (t === "--") break;
    if (t === "--no-update") noUpdate = true;
    else if (t === "--host" && argv[i + 1] !== undefined) host = argv[++i];
    else if (t.startsWith("--host=")) host = t.slice("--host=".length);
  }
  return { ...(host !== undefined ? { host } : {}), noUpdate };
}

/** Whether the user opted out (`--no-update`, `GITTIFACTS_NO_UPDATE`) or this is the updated run. */
export function updateDisabled(argv: readonly string[], env: Env): boolean {
  if (env[UPDATED_ENV] === "1") return true;
  const off = env.GITTIFACTS_NO_UPDATE;
  if (off !== undefined && off !== "" && off !== "0" && off.toLowerCase() !== "false") return true;
  return updateFlags(argv).noUpdate;
}

/**
 * The host to fetch code from, or null. A `.gittifacts.json` host counts only when the user
 * logged in to it or created a project there from this machine; otherwise the next source wins.
 */
export function updateHost(
  opts: Pick<UpdateOptions, "argv" | "env" | "cwd" | "home">,
): string | null {
  try {
    const creds = readCredentials(credentialsPath(opts.env, opts.home));
    let project = null;
    try {
      project = findProject(opts.cwd)?.config ?? null;
    } catch {
      project = null;
    }
    if (project) {
      const named = resolveHost(undefined, {}, project, { version: 1, hosts: {} });
      const h = named ? creds.hosts[named.host] : undefined;
      const known = h?.login !== undefined || Object.keys(h?.projects ?? {}).length > 0;
      if (!known) project = null;
    }
    const resolved = resolveHost(updateFlags(opts.argv).host, opts.env, project, creds);
    if (!resolved || !isSecureOrigin(resolved.host)) return null;
    return resolved.host;
  } catch {
    return null;
  }
}

export function cacheDir(env: Env, home: string): string {
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "gittifacts", "cli");
}

/** A build this module cached (`…/gittifacts/cli/<sha256>.mjs`). */
export function isCachedBuild(path: string): boolean {
  return /[\\/]gittifacts[\\/]cli[\\/][0-9a-f]{64}\.mjs$/.test(path);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stampPath(dir: string, host: string): string {
  return join(dir, `check-${sha256(Buffer.from(host)).slice(0, 16)}.json`);
}

function readStamp(dir: string, host: string): Stamp | null {
  try {
    const parsed = Stamp.safeParse(JSON.parse(readFileSync(stampPath(dir, host), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Writes `bytes` to `path` through a temp file in the same directory and a rename. */
function writeAtomic(dir: string, path: string, bytes: Uint8Array | string): void {
  ensureDir(dir);
  const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * GET without credentials or redirects; the body is read under the same timeout and aborted as
 * soon as it passes `maxBytes`. Null on any failure.
 */
export async function fetchCapped(
  fetchFn: FetchFn,
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  if (!isSecureOrigin(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, redirect: "error", credentials: "omit" });
    if (!res.ok || res.body === null) return null;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        ctrl.abort();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One regular file from a tar archive (ustar, as `npm pack` writes it), or null. */
export function readTarEntry(tar: Uint8Array, name: string): Uint8Array | null {
  const buf = Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength);
  const field = (at: number, len: number) => {
    const raw = buf.subarray(at, at + len);
    const nul = raw.indexOf(0);
    return raw.subarray(0, nul < 0 ? len : nul).toString("utf8");
  };
  let off = 0;
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) return null;
    const size = Number.parseInt(field(off + 124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    const type = field(off + 156, 1);
    const prefix = field(off + 345, 155);
    const path = prefix === "" ? field(off, 100) : `${prefix}/${field(off, 100)}`;
    const start = off + 512;
    if (start + size > buf.length) return null;
    if ((type === "0" || type === "") && path === name) return buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** The cached build for `sha`, when it exists and still hashes to `sha`. */
function cachedBuild(dir: string, sha: string): string | null {
  const file = join(dir, `${sha}.mjs`);
  try {
    return sha256(readFileSync(file)) === sha ? file : null;
  } catch {
    return null;
  }
}

/** Downloads, verifies and caches the build `doc` names; the cached file, or null. */
async function download(host: string, doc: VersionDoc, dir: string, fetchFn: FetchFn) {
  const tgz = await fetchCapped(
    fetchFn,
    `${host}${TARBALL_PATH}`,
    MAX_TARBALL_BYTES,
    DOWNLOAD_TIMEOUT_MS,
  );
  if (tgz === null) return null;
  const cli = readTarEntry(gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED_BYTES }), BUNDLE_ENTRY);
  // Verified before anything touches the disk.
  if (cli === null || cli.byteLength !== doc.size || sha256(cli) !== doc.sha256) return null;
  const file = join(dir, `${doc.sha256}.mjs`);
  writeAtomic(dir, file, cli);
  return file;
}

async function fetchVersion(host: string, fetchFn: FetchFn): Promise<VersionDoc | null> {
  const body = await fetchCapped(
    fetchFn,
    `${host}${VERSION_PATH}`,
    MAX_VERSION_BYTES,
    VERSION_TIMEOUT_MS,
  );
  if (body === null) return null;
  try {
    const parsed = VersionDoc.safeParse(JSON.parse(Buffer.from(body).toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The build to run instead of this one (a cached, verified file), or null to carry on here.
 * Never throws, never writes to stdout.
 */
export async function selfUpdate(opts: UpdateOptions): Promise<string | null> {
  try {
    if (updateDisabled(opts.argv, opts.env)) return null;
    const host = updateHost(opts);
    if (host === null) return null;
    const dir = cacheDir(opts.env, opts.home);
    const self = sha256(readFileSync(opts.selfFile));
    const stamp = readStamp(dir, host);
    const fresh =
      stamp !== null && stamp.checkedAt <= opts.now && opts.now - stamp.checkedAt < CHECK_EVERY_MS;
    // git waits on the credential helper: never fetch there, only use what is cached.
    const helper = opts.argv[0] === "git-credential";
    let target = stamp?.sha256 ?? null;
    let downloaded = false;
    if (!helper && !fresh) {
      const doc = await fetchVersion(host, opts.fetch);
      // Stamped on failure too, so a platform that is down costs one timeout per 10 minutes.
      target = doc?.sha256 ?? target;
      try {
        writeAtomic(
          dir,
          stampPath(dir, host),
          JSON.stringify({ checkedAt: opts.now, sha256: target }),
        );
      } catch {
        // A read-only home still runs the command.
      }
      if (doc !== null && doc.sha256 !== self && cachedBuild(dir, doc.sha256) === null) {
        downloaded = (await download(host, doc, dir, opts.fetch)) !== null;
      }
    }
    if (target === null || target === self) return null;
    const file = cachedBuild(dir, target);
    if (file !== null && downloaded && opts.stderr.isTTY === true) {
      opts.stderr.write(`gittifacts: updated to ${target.slice(0, 12)} from ${host}\n`);
    }
    return file;
  } catch {
    return null;
  }
}

/**
 * Runs `file` with this process's node, flags and argv, stdio inherited and `GITTIFACTS_UPDATED=1`.
 * Resolves with its exit code, or null when it could not start (then the caller runs itself).
 */
export function runBuild(file: string, argv: readonly string[], env: Env): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, file, ...argv], {
      stdio: "inherit",
      env: { ...env, [UPDATED_ENV]: "1" },
    });
    // Ctrl-C reaches the child through the terminal; this process waits for its exit code.
    const ignore = () => {};
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGINT", ignore);
    process.on("SIGTERM", forward);
    const done = (code: number | null) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", forward);
      resolve(code);
    };
    child.on("error", () => done(null));
    child.on("exit", (code, signal) =>
      done(code ?? (signal === null ? 1 : 128 + signalNumber(signal))),
    );
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  return { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal as string] ?? 1;
}
