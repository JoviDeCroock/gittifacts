/**
 * A real git smart-HTTP server for integration tests: a Node http server that runs
 * `git http-backend` as a CGI per request. Optionally requires a token (Bearer, or Basic with
 * the token as password) to emulate Cloudflare Artifacts' auth.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { GitAuth, GitRemote } from "../../src/index.js";
import { git, gitEnv, tempDir } from "./git.js";

export interface RequestLogEntry {
  method: string;
  path: string;
  gitProtocol: string | undefined;
  status: number;
}

export interface GitHttpServer {
  root: string;
  baseUrl: string;
  token: string | undefined;
  log: RequestLogEntry[];
  /** `http://127.0.0.1:<port>/<name>.git` */
  url(name: string): string;
  /** A GitRemote for `name` using the server token as Bearer (or `auth` if given). */
  remote(name: string, auth?: GitAuth | null, fetchImpl?: typeof fetch): GitRemote;
  /** Filesystem path of the bare repo. */
  repoPath(name: string): string;
  /** `git init --bare` with push over HTTP enabled; extra config applied with `git config`. */
  createBareRepo(name: string, config?: Record<string, string>): string;
  /** Args for the git CLI to authenticate against this server. */
  gitAuthArgs(): string[];
  close(): Promise<void>;
}

interface CgiResult {
  stdout: Buffer;
  stderr: string;
}

function runCgi(env: NodeJS.ProcessEnv, body: Buffer): Promise<CgiResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["http-backend"], { env });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", () => resolve({ stdout: Buffer.concat(out), stderr }));
    child.stdin.on("error", () => {}); // backend may exit before reading everything (e.g. 403)
    child.stdin.end(body);
  });
}

/** Splits CGI output into status, headers and body (RFC 3875 §6). */
function parseCgi(stdout: Buffer): { status: number; headers: Record<string, string>; body: Buffer } {
  let sep = stdout.indexOf("\r\n\r\n");
  let sepLen = 4;
  if (sep < 0) {
    sep = stdout.indexOf("\n\n");
    sepLen = 2;
  }
  if (sep < 0) return { status: 502, headers: {}, body: stdout };
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of stdout.subarray(0, sep).toString("latin1").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers[key] = value;
  }
  return { status, headers, body: stdout.subarray(sep + sepLen) };
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header) return false;
  if (header === `Bearer ${token}`) return true;
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  // Like Artifacts: the Basic password is the token without its `?expires=` suffix.
  return colon > 0 && decoded.slice(colon + 1) === token.split("?expires=")[0];
}

export async function startGitHttpServer(opts: { token?: string } = {}): Promise<GitHttpServer> {
  const tmp = tempDir("gitwire-server-");
  const root = join(tmp.path, "repos");
  mkdirSync(root);
  const log: RequestLogEntry[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const gitProtocol = req.headers["git-protocol"] as string | undefined;
    const entry: RequestLogEntry = { method: req.method ?? "GET", path: url.pathname + url.search, gitProtocol, status: 0 };
    log.push(entry);
    const reply = (status: number, headers: Record<string, string>, body: Buffer | string) => {
      entry.status = status;
      res.writeHead(status, headers).end(body);
    };
    if (opts.token && !authorized(req.headers.authorization, opts.token)) {
      reply(401, { "WWW-Authenticate": 'Basic realm="gitwire"', "Content-Type": "text/plain" }, "unauthorized\n");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c)); // Node already decoded chunked transfer-encoding
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      // The git CLI gzips large upload-pack requests; http-backend could inflate them itself,
      // but we decode here so CONTENT_LENGTH is always exact.
      if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      const env = gitEnv(tmp.path, {
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.length),
        REMOTE_USER: "gitwire",
        REMOTE_ADDR: "127.0.0.1",
        SERVER_PROTOCOL: "HTTP/1.1",
        ...(gitProtocol ? { GIT_PROTOCOL: gitProtocol, HTTP_GIT_PROTOCOL: gitProtocol } : {}),
      });
      runCgi(env, body).then(
        ({ stdout, stderr }) => {
          const cgi = parseCgi(stdout);
          if (cgi.status >= 500 && stderr) cgi.headers["X-Backend-Stderr"] = stderr.replace(/\s+/g, " ").slice(0, 500);
          reply(cgi.status, cgi.headers, cgi.body);
        },
        (err: Error) => reply(500, { "Content-Type": "text/plain" }, String(err)),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const self: GitHttpServer = {
    root,
    baseUrl,
    token: opts.token,
    log,
    url: (name) => `${baseUrl}/${name}.git`,
    repoPath: (name) => join(root, `${name}.git`),
    remote(name, auth, fetchImpl) {
      const r: GitRemote = { url: self.url(name) };
      if (auth) r.auth = auth;
      else if (auth === undefined && opts.token) r.auth = { bearer: opts.token };
      if (fetchImpl) r.fetch = fetchImpl;
      return r;
    },
    createBareRepo(name, config = {}) {
      const path = self.repoPath(name);
      git(root, ["init", "-q", "--bare", "-b", "main", path]);
      const settings = { "http.receivepack": "true", "uploadpack.allowFilter": "true", ...config };
      for (const [k, v] of Object.entries(settings)) git(path, ["config", k, v]);
      return path;
    },
    gitAuthArgs: () => (opts.token ? ["-c", `http.extraHeader=Authorization: Bearer ${opts.token}`] : []),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      tmp.cleanup();
    },
  };
  return self;
}
