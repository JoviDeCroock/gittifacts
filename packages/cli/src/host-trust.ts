/**
 * Which hosts the CLI sends a token to. `.gittifacts.json` is read from the cwd or any parent, so
 * a checkout (a hostile repo, a malicious Change's head) can name any host: what it says is only
 * trusted where it can't leak a secret.
 *
 * - The host and the MCP URL must be https (plain http only on loopback, for local dev).
 * - The project file's `mcpUrl` is used only when it is on the resolved host; otherwise it is
 *   ignored with a warning, and the CLI talks to `<host>/mcp`.
 * - `GITTIFACTS_TOKEN` goes to a host the user chose (`--host`, `GITTIFACTS_HOST`, the last
 *   login, the build default). A host named only by the project file gets it when the user
 *   logged in to that host or created a project there from this machine (the credentials file
 *   has it), or `GITTIFACTS_TOKEN_HOST` names it. Otherwise the CLI refuses, with the fix.
 *   Login and project tokens are stored per host, so they only ever go to their own host.
 */
import { shellQuote } from "./calls.js";
import {
  type Credentials,
  normalizeHost,
  type ProjectConfig,
  type ResolvedHost,
} from "./config.js";
import { cliError } from "./errors.js";

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/** `http:` is allowed only to loopback; anything else must be `https:`. */
export function isSecureOrigin(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.test(u.hostname);
}

/** Refuses a non-loopback `http:` URL before anything (a token) is sent to it. */
export function requireSecureOrigin(url: string, from: string): void {
  if (isSecureOrigin(url)) return;
  // No ready-made command: the URL may come from a checkout, and a fix an agent runs as is must
  // not send its token to a host nobody vetted.
  throw cliError("insecure-host", `refusing to talk to ${url} (from ${from}) over plain http`, {
    explanation: `Tokens would cross the network in clear text. Change ${from} to your platform's https:// origin (plain http is only allowed to localhost, 127.0.0.1 and [::1]).`,
  });
}

/**
 * The MCP endpoint: `GITTIFACTS_MCP_URL`, else the project file's `mcpUrl` when it is on `host`,
 * else `<host>/mcp`. `warn` hears about an `mcpUrl` that was ignored.
 */
export function trustedMcpUrl(
  host: string,
  project: { path: string; config: ProjectConfig } | null,
  env: Env,
  warn: (line: string) => void,
): string {
  if (env.GITTIFACTS_MCP_URL) {
    requireSecureOrigin(env.GITTIFACTS_MCP_URL, "GITTIFACTS_MCP_URL");
    return env.GITTIFACTS_MCP_URL;
  }
  const fromFile = project?.config.mcpUrl;
  if (fromFile) {
    let origin: string | null = null;
    try {
      origin = new URL(fromFile).origin;
    } catch {
      origin = null;
    }
    if (origin === host) return fromFile;
    warn(
      `gittifacts: ignoring mcpUrl ${JSON.stringify(fromFile)} in ${project.path}: it is not on ${host}; using ${host}/mcp`,
    );
  }
  return `${host}/mcp`;
}

/** Whether `GITTIFACTS_TOKEN` may be sent to `resolved.host` (see the module comment). */
export function envTokenAllowed(resolved: ResolvedHost, env: Env, creds: Credentials): boolean {
  if (resolved.source !== "project") return true;
  const h = creds.hosts[resolved.host];
  if (h?.login || Object.keys(h?.projects ?? {}).length > 0) return true;
  if (!env.GITTIFACTS_TOKEN_HOST) return false;
  try {
    return normalizeHost(env.GITTIFACTS_TOKEN_HOST) === resolved.host;
  } catch {
    return false;
  }
}

/** The refusal when `GITTIFACTS_TOKEN` would go to a host only the project file names. */
export function untrustedHostError(host: string, projectPath: string) {
  return cliError(
    "untrusted-host",
    `not sending GITTIFACTS_TOKEN to ${host}: only ${projectPath} names that host`,
    {
      explanation: `The CLI reads .gittifacts.json from this directory or a parent, so a checkout can point it anywhere. Check that ${host} is your platform first (an agent: ask a human). If it is, say so: pass --host, set GITTIFACTS_HOST or GITTIFACTS_TOKEN_HOST to it, or log in to it once. If not, remove or fix ${projectPath}.`,
      // Look, don't send: a fix an agent runs as is must not hand the token to that host.
      command: `cat ${shellQuote(projectPath)}`,
    },
    { details: { host, hostSource: "project", projectFile: projectPath } },
  );
}
