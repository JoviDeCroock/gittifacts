/**
 * Where the CLI finds its host and token.
 *
 * - `.gittifacts.json` (found upward from the cwd): `{ host, projectId, remote }`. No secrets; safe
 *   to commit.
 * - `~/.config/gittifacts/credentials.json` (`$XDG_CONFIG_HOME`, or `GITTIFACTS_CONFIG_DIR`),
 *   mode 0600 in a 0700 directory: the login token per host, and the token of each project
 *   created without an account (unclaimed).
 *
 * Host: `--host` > `GITTIFACTS_HOST` > `.gittifacts.json` > the last host logged in to.
 * Token: `GITTIFACTS_TOKEN` > the host's login token > the project's own token.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cliError, usageError } from "./errors.js";
import { isRecord } from "./tools/schema.js";

export const PROJECT_FILE = ".gittifacts.json";
export const CREDENTIALS_FILE = "credentials.json";

type Env = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------- host

/** `example.com` → `https://example.com`; any path is dropped (the host is an origin). */
export function normalizeHost(input: string): string {
  const raw = input.trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(raw);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `${local ? "http" : "https"}://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw usageError(`not a valid host: ${JSON.stringify(input)}`, {
      explanation: "Pass the platform origin, e.g. --host https://gittifacts.example.",
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw usageError(`host must be http(s): ${input}`, {
      explanation: "Pass the platform origin, e.g. --host https://gittifacts.example.",
    });
  }
  return url.origin;
}

export type HostSource = "flag" | "env" | "project" | "login" | "build";

export interface ResolvedHost {
  host: string;
  source: HostSource;
}

/** Baked in at build time (`GITTIFACTS_DEFAULT_HOST=… node build.mjs`); unset by default. */
const BUILD_DEFAULT_HOST: string | undefined = process.env.GITTIFACTS_BUILD_DEFAULT_HOST;

export function resolveHost(
  flag: string | undefined,
  env: Env,
  project: ProjectConfig | null,
  creds: Credentials,
): ResolvedHost | null {
  if (flag) return { host: normalizeHost(flag), source: "flag" };
  if (env.GITTIFACTS_HOST) return { host: normalizeHost(env.GITTIFACTS_HOST), source: "env" };
  if (project) return { host: normalizeHost(project.host), source: "project" };
  if (creds.defaultHost) return { host: normalizeHost(creds.defaultHost), source: "login" };
  if (BUILD_DEFAULT_HOST) return { host: normalizeHost(BUILD_DEFAULT_HOST), source: "build" };
  return null;
}

export function noHostError() {
  return cliError("no-host", "no platform host configured", {
    explanation:
      "Tell the CLI which platform to use: pass --host <origin>, set GITTIFACTS_HOST, run it inside a project with .gittifacts.json, or log in once with --host.",
    command: "gittifacts login --host https://<host>",
  });
}

export function mcpUrlFor(host: string, project: ProjectConfig | null, env: Env): string {
  if (env.GITTIFACTS_MCP_URL) return env.GITTIFACTS_MCP_URL;
  if (project?.mcpUrl && normalizeHost(project.host) === host) return project.mcpUrl;
  return `${host}/mcp`;
}

// ---------------------------------------------------------------- project file

export interface ProjectConfig {
  host: string;
  projectId: string;
  /** Git remote URL (no credentials). */
  remote: string;
  mcpUrl?: string | undefined;
}

function parseProject(v: unknown): ProjectConfig | null {
  if (!isRecord(v)) return null;
  if (typeof v.host !== "string" || typeof v.projectId !== "string") return null;
  return {
    host: v.host,
    projectId: v.projectId,
    remote: typeof v.remote === "string" ? v.remote : "",
    mcpUrl: typeof v.mcpUrl === "string" ? v.mcpUrl : undefined,
  };
}

/** The nearest `.gittifacts.json` at or above `cwd`. */
export function findProject(cwd: string): { path: string; config: ProjectConfig } | null {
  let dir = cwd;
  for (;;) {
    const path = join(dir, PROJECT_FILE);
    if (existsSync(path)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        throw cliError("config", `${path} is not valid JSON`, {
          explanation: `Fix or delete ${path}; \`gittifacts init --force\` rewrites it.`,
          command: `cat ${path}`,
        }, { details: e instanceof Error ? e.message : String(e) });
      }
      const config = parseProject(parsed);
      if (!config) {
        throw cliError("config", `${path} needs string "host" and "projectId" fields`, {
          explanation: `Fix or delete ${path}; \`gittifacts init --force\` rewrites it.`,
        });
      }
      return { path, config };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function writeProject(dir: string, config: ProjectConfig): string {
  const path = join(dir, PROJECT_FILE);
  const body: Record<string, string> = {
    host: config.host,
    projectId: config.projectId,
    remote: config.remote,
  };
  if (config.mcpUrl) body.mcpUrl = config.mcpUrl;
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

// ---------------------------------------------------------------- credentials

export interface LoginToken {
  token: string;
  tokenType: string;
  scope: string | null;
  /** ISO time, or null when the server gave no expiry. */
  expiresAt: string | null;
  obtainedAt: string;
  via: "device-flow";
}

export interface ProjectToken {
  token: string;
  expiresAt: string | null;
  claimUrl: string | null;
  createdAt: string;
}

export interface HostCredentials {
  login?: LoginToken | undefined;
  projects?: Record<string, ProjectToken> | undefined;
}

export interface Credentials {
  version: 1;
  defaultHost?: string | undefined;
  hosts: Record<string, HostCredentials>;
}

export function configDir(env: Env, home: string): string {
  if (env.GITTIFACTS_CONFIG_DIR) return env.GITTIFACTS_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "gittifacts");
}

export function credentialsPath(env: Env, home: string): string {
  return join(configDir(env, home), CREDENTIALS_FILE);
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

function parseLogin(v: unknown): LoginToken | undefined {
  if (!isRecord(v) || typeof v.token !== "string") return undefined;
  return {
    token: v.token,
    tokenType: str(v.tokenType) ?? "Bearer",
    scope: str(v.scope),
    expiresAt: str(v.expiresAt),
    obtainedAt: str(v.obtainedAt) ?? new Date(0).toISOString(),
    via: "device-flow",
  };
}

function parseProjects(v: unknown): Record<string, ProjectToken> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, ProjectToken> = {};
  for (const [id, p] of Object.entries(v)) {
    if (!isRecord(p) || typeof p.token !== "string") continue;
    out[id] = {
      token: p.token,
      expiresAt: str(p.expiresAt),
      claimUrl: str(p.claimUrl),
      createdAt: str(p.createdAt) ?? new Date(0).toISOString(),
    };
  }
  return out;
}

export function readCredentials(path: string): Credentials {
  if (!existsSync(path)) return { version: 1, hosts: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw cliError("config", `${path} is not valid JSON`, {
      explanation: `Delete ${path} and log in again.`,
      command: `rm ${path} && gittifacts login`,
    }, { details: e instanceof Error ? e.message : String(e) });
  }
  const hosts: Record<string, HostCredentials> = {};
  if (isRecord(raw) && isRecord(raw.hosts)) {
    for (const [host, h] of Object.entries(raw.hosts)) {
      if (!isRecord(h)) continue;
      hosts[host] = { login: parseLogin(h.login), projects: parseProjects(h.projects) };
    }
  }
  const defaultHost = isRecord(raw) ? str(raw.defaultHost) : null;
  return { version: 1, hosts, ...(defaultHost ? { defaultHost } : {}) };
}

/** Writes atomically (temp file + rename), mode 0600 in a 0700 directory. */
export function writeCredentials(path: string, creds: Credentials): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function updateCredentials(path: string, fn: (c: Credentials) => void): Credentials {
  const creds = readCredentials(path);
  fn(creds);
  writeCredentials(path, creds);
  return creds;
}

// ---------------------------------------------------------------- token

export type TokenSource = "env" | "login" | "project";

export interface ResolvedToken {
  token: string;
  source: TokenSource;
  expiresAt: string | null;
}

function live(expiresAt: string | null, now: number): boolean {
  return expiresAt === null || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) > now;
}

export function resolveToken(
  host: string,
  env: Env,
  creds: Credentials,
  project: ProjectConfig | null,
  now: number,
): ResolvedToken | null {
  if (env.GITTIFACTS_TOKEN) return { token: env.GITTIFACTS_TOKEN, source: "env", expiresAt: null };
  const h = creds.hosts[host];
  if (h?.login && live(h.login.expiresAt, now)) {
    return { token: h.login.token, source: "login", expiresAt: h.login.expiresAt };
  }
  if (project && normalizeHost(project.host) === host) {
    const p = h?.projects?.[project.projectId];
    if (p && live(p.expiresAt, now)) return { token: p.token, source: "project", expiresAt: p.expiresAt };
  }
  return null;
}
