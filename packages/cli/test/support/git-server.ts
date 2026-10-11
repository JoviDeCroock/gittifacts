/**
 * Real git over smart HTTP for the e2e tests: `git http-backend` behind node:http, with the auth
 * rules of the two git endpoints the CLI talks to. One port, two origins:
 *
 * - the platform, `http://127.0.0.1:<port>`: `/mcp` is forwarded to the real MCP server, and
 *   `/git/<owner>/<repo>.git` is the read-only proxy (Bearer or Basic `x-access-token:<login>`;
 *   git-receive-pack refused with 403, like apps/platform/src/integrations/git-proxy.ts);
 * - the Artifacts remote, `http://localhost:<port>/artifacts/<fork>.git`: a push token minted
 *   for that fork, as Bearer (whole token) or Basic `x:<token without ?expires=>`; Basic with the
 *   suffix is refused, as Artifacts does. No credentials: 401 with a Basic challenge.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export interface GitServer {
  host: string;
  artifacts: string;
  root: string;
  /** Bare repo path of a fork (or of `main`). */
  repo(name: string): string;
  /** Creates fork `name` as a copy of main. */
  fork(name: string): void;
  /** A push token for `fork`, `tok<n>?expires=<unix>`. */
  mint(fork: string): { token: string; expiresAt: string };
  /** The branch head in a bare repo. */
  head(name: string, branch?: string): string | null;
  /** Requests seen: `<origin-kind> <method> <path> <auth-kind>`. */
  log: string[];
  close(): Promise<void>;
}

const challenge = (res: ServerResponse, body = "Authentication required") => {
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="artifacts"',
    "content-type": "text/plain",
  });
  res.end(`${body}\n`);
};

function credential(header: string | undefined): { kind: string; secret: string } | null {
  const bearer = /^Bearer (.+)$/.exec(header ?? "");
  if (bearer?.[1]) return { kind: "bearer", secret: bearer[1] };
  const basic = /^Basic (.+)$/.exec(header ?? "");
  if (!basic?.[1]) return null;
  const decoded = Buffer.from(basic[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  return { kind: `basic:${decoded.slice(0, i)}`, secret: decoded.slice(i + 1) };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Runs `git http-backend` (CGI) for `pathInfo` under `root` and relays its answer. */
async function backend(
  root: string,
  pathInfo: string,
  req: IncomingMessage,
  res: ServerResponse,
  user: string,
) {
  const url = new URL(req.url ?? "/", "http://x");
  const body = await readBody(req);
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: pathInfo,
      REQUEST_METHOD: req.method ?? "GET",
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(body.length),
      HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
      GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
      REMOTE_USER: user,
      REMOTE_ADDR: "127.0.0.1",
    },
  });
  child.stdin.end(body);
  const out: Buffer[] = [];
  for await (const c of child.stdout) out.push(c as Buffer);
  const all = Buffer.concat(out);
  const split = all.indexOf("\r\n\r\n");
  const head = all.subarray(0, split).toString("utf8").split("\r\n");
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of head) {
    const i = line.indexOf(":");
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k.toLowerCase() === "status") status = Number.parseInt(v, 10);
    else if (k) headers[k] = v;
  }
  res.writeHead(status, headers);
  res.end(all.subarray(split + 4));
}

export async function serveGit(opts: {
  root: string;
  /** Where /mcp is forwarded (read per request: the MCP server may start after this one). */
  mcpUrl: () => string;
  /** Tokens the read-only proxy accepts. */
  loginTokens: readonly string[];
}): Promise<GitServer> {
  const { root } = opts;
  const art = join(root, "artifacts");
  mkdirSync(art, { recursive: true });
  const tokens = new Map<string, string>();
  const log: string[] = [];
  let n = 0;
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "";
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (host.startsWith("127.0.0.1") && path.startsWith("/mcp")) {
        const body =
          req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
        const hop = new Set([
          "host",
          "connection",
          "content-length",
          "transfer-encoding",
          "keep-alive",
        ]);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string" && !hop.has(k)) headers.set(k, v);
        }
        const r = await fetch(opts.mcpUrl(), { method: req.method ?? "GET", headers, body });
        const back = Object.fromEntries(
          [...r.headers].filter(([k]) => !hop.has(k) && k !== "content-encoding"),
        );
        res.writeHead(r.status, back);
        if (r.body) for await (const chunk of r.body) res.write(chunk);
        res.end();
        return;
      }
      const cred = credential(req.headers.authorization);
      const service = new URL(req.url ?? "/", "http://x").searchParams.get("service");
      const proxy = /^\/git\/[a-z0-9-]+\/([A-Za-z0-9._-]+?)\.git(\/.*)$/.exec(path);
      if (host.startsWith("127.0.0.1") && proxy) {
        log.push(`proxy ${req.method} ${path} ${cred?.kind ?? "none"}`);
        if (!cred) return challenge(res);
        if (!opts.loginTokens.includes(cred.secret))
          return challenge(res, "invalid or expired token");
        if (path.endsWith("git-receive-pack") || service === "git-receive-pack") {
          res.writeHead(403, { "content-type": "application/json" });
          return res.end(
            '{"error":{"code":"read-only","message":"git push is not available through /git/"}}',
          );
        }
        return backend(art, `/main.git${proxy[2]}`, req, res, "proxy");
      }
      const fork = /^\/artifacts\/([A-Za-z0-9._-]+?)\.git(\/.*)$/.exec(path);
      if (host.startsWith("localhost") && fork?.[1]) {
        log.push(`artifacts ${req.method} ${path} ${cred?.kind ?? "none"}`);
        if (!cred) return challenge(res);
        const full =
          cred.kind === "bearer"
            ? cred.secret
            : [...tokens.keys()].find(
                (t) => t.split("?expires=")[0] === cred.secret && cred.secret !== t,
              );
        if (!full || tokens.get(full) !== fork[1])
          return challenge(res, "Invalid or expired token");
        return backend(art, `/${fork[1]}.git${fork[2]}`, req, res, "agent");
      }
      res.writeHead(404);
      res.end("not found\n");
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const repo = (name: string) => join(art, `${name}.git`);
  return {
    host: `http://127.0.0.1:${port}`,
    artifacts: `http://localhost:${port}/artifacts`,
    root,
    repo,
    fork(name) {
      execFileSync("git", ["clone", "-q", "--bare", repo("main"), repo(name)]);
      execFileSync("git", ["config", "http.receivepack", "true"], { cwd: repo(name) });
    },
    mint(fork) {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = `tok${++n}?expires=${exp}`;
      tokens.set(token, fork);
      return { token, expiresAt: new Date(exp * 1000).toISOString() };
    },
    head(name, branch = "main") {
      try {
        return execFileSync("git", ["rev-parse", branch], {
          cwd: repo(name),
          encoding: "utf8",
        }).trim();
      } catch {
        return null;
      }
    },
    log,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
