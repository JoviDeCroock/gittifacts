/**
 * Read-only git smart HTTP for integrations (and agent tokens):
 *
 *   GET  /git/<owner>/<repo>.git/info/refs?service=git-upload-pack
 *   POST /git/<owner>/<repo>.git/git-upload-pack
 *   … and the same under /git/<owner>/<repo>/changes/<changeId>.git (a Change's fork head)
 *
 * The Worker authenticates the caller (Basic `x-access-token:<token>` or Bearer), checks the repo
 * against its grant, mints a fresh Artifacts **read** token (5 min, never returned) and streams the
 * exchange to the Artifacts remote. Who may use it:
 * - integration tokens (`gti_…`) with `contents:read`, on their installation's repos;
 * - agent tokens (`gtf_…`) with `repo:read` whose audience includes the HTTP API, on their repos.
 * Human sessions are not git credentials here (create an agent token). `git-receive-pack` is
 * refused for everyone: nothing pushes through this proxy (agents push to their fork with
 * `refresh_push_token`; only the merge queue moves a default branch).
 */
import type { Principal } from "@app/domain";
import type { Context } from "hono";
import { canAccess } from "../access/access.js";
import type { AppEnv } from "../app-env.js";
import { isAgentToken, verifyAgentToken } from "../auth/agent-tokens.js";
import { enforceUnclaimedRequestRate } from "../limits/request-limit.js";
import { urlsFor } from "../oauth/context.js";
import { audienceAllows } from "../oauth/urls.js";
import { enforceIntegrationRate, verifyIntegrationToken } from "./auth.js";
import { looksLikeIntegrationToken } from "./crypto.js";
import { gitHostFor } from "./git-host.js";
import { resolveRepoPath } from "./handles.js";

export const GIT_PREFIX = "/git/";
const READ_TOKEN_TTL_SEC = 300;
const PATH =
  /^\/git\/([A-Za-z0-9][A-Za-z0-9-]{0,62})\/([A-Za-z0-9][A-Za-z0-9._-]{1,62}?)(?:\/changes\/([A-Za-z0-9_-]{1,64}))?\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

interface Parsed {
  owner: string;
  repo: string;
  changeId: string | null;
  endpoint: "info/refs" | "git-upload-pack" | "git-receive-pack";
}

export function parseGitPath(pathname: string): Parsed | null {
  const m = PATH.exec(pathname);
  if (!m?.[1] || !m[2] || !m[4]) return null;
  return {
    owner: m[1],
    repo: m[2],
    changeId: m[3] ?? null,
    endpoint: m[4] as Parsed["endpoint"],
  };
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function errorJson(
  status: number,
  code: string,
  message: string,
  explanation: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message, fix: { explanation } } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

const CHALLENGE = { "www-authenticate": 'Basic realm="gittifacts", charset="UTF-8"' };

/** Basic (password = token, or username = token with an empty password) or Bearer. */
export function gitCredential(header: string | undefined): string | null {
  if (!header) return null;
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (bearer?.[1]) return bearer[1];
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!basic?.[1]) return null;
  let decoded: string;
  try {
    decoded = atob(basic[1]);
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  const user = i < 0 ? decoded : decoded.slice(0, i);
  const pass = i < 0 ? "" : decoded.slice(i + 1);
  return pass !== "" ? pass : user !== "" ? user : null;
}

/** Responses are built per request (a Response made at module scope can't serve two requests). */
const receivePackRefused = () =>
  errorJson(
    403,
    "read-only",
    "git push is not available through /git/: integrations read code, they never write it",
    "Deploy platforms only clone and fetch here. Agents push a Change to its own fork with the token from refresh_push_token; only the merge queue moves a default branch.",
  );

type Authed = { kind: "integration" | "agent"; principal: Principal };

/** Resolve the git credential to a principal that may read code here, or a ready error response. */
async function authenticate(c: Context<AppEnv>, token: string): Promise<Authed | Response> {
  const svc = c.get("services");
  const denied = errorJson(
    401,
    "unauthorized",
    "invalid or expired token",
    "Use a fresh access token: refresh it with your refresh token (integrations) or mint a new agent token.",
    CHALLENGE,
  );
  if (looksLikeIntegrationToken(token)) {
    const v = await verifyIntegrationToken(svc, token);
    if (!v) return denied;
    await enforceIntegrationRate(c.env, v.integration.id);
    if (!v.principal.scopes.includes("contents:read")) {
      return errorJson(
        403,
        "insufficient-scope",
        "missing scope contents:read",
        "Request contents:read when installing the integration; cloning needs it.",
      );
    }
    return { kind: "integration", principal: v.principal };
  }
  if (isAgentToken(token)) {
    const v = await verifyAgentToken(svc.store, token, svc.clock.now(), svc.waitUntil);
    if (!v) return denied;
    if (!audienceAllows(v.audience, urlsFor(c).apiResource)) {
      return errorJson(
        401,
        "unauthorized",
        "this token is bound to the MCP server only",
        "Use a token whose audience includes the HTTP API (device-flow tokens do), or refresh_push_token for git access to your Change.",
        CHALLENGE,
      );
    }
    await enforceUnclaimedRequestRate(c.env, v.principal);
    if (!v.principal.scopes.includes("repo:read")) {
      return errorJson(
        403,
        "insufficient-scope",
        "missing scope repo:read",
        "Agent tokens need repo:read to clone.",
      );
    }
    return { kind: "agent", principal: v.principal };
  }
  return errorJson(
    401,
    "unauthorized",
    "unsupported git credential",
    "Authenticate with an integration access token (Basic x-access-token:<token>, or Bearer) or an agent token (gtf_…). Browser sessions are not git credentials.",
    CHALLENGE,
  );
}

const repoNotFound = () =>
  errorJson(
    404,
    "not-found",
    "repository not found",
    "Check the URL (https://<host>/git/<owner>/<repo>.git, as in the webhook payload's cloneUrl) and that your installation includes the repo.",
  );

/** The `/git/*` handler (mounted in src/app.ts). */
export async function handleGit(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  const parsed = parseGitPath(url.pathname);
  if (!parsed) {
    return errorJson(
      404,
      "not-found",
      "not a git smart-HTTP path",
      "Clone https://<host>/git/<owner>/<repo>.git (smart HTTP only; the dumb protocol is not served).",
    );
  }
  const service = url.searchParams.get("service");
  if (parsed.endpoint === "git-receive-pack" || service === "git-receive-pack")
    return receivePackRefused();
  const isRefs = parsed.endpoint === "info/refs";
  if (isRefs ? c.req.method !== "GET" || service !== "git-upload-pack" : c.req.method !== "POST") {
    return errorJson(
      400,
      "invalid-request",
      "unsupported git request",
      "Only smart HTTP git-upload-pack is served (git clone / fetch / ls-remote).",
    );
  }
  const token = gitCredential(c.req.header("authorization"));
  if (token === null)
    return text(
      401,
      "Authentication required: use your access token as the password (username x-access-token).",
      CHALLENGE,
    );
  const auth = await authenticate(c, token);
  if (auth instanceof Response) return auth;

  const svc = c.get("services");
  const repo = await resolveRepoPath(svc, parsed.owner, parsed.repo);
  // The chokepoint decides (memberships, session/installation grants, unclaimed rules).
  if (!repo || !(await canAccess(svc, auth.principal, repo, "read"))) return repoNotFound();
  let artifactsName = repo.artifactsName;
  if (parsed.changeId !== null) {
    const change = await svc.store.getChange(parsed.changeId);
    if (!change || change.repoId !== repo.id) return repoNotFound();
    artifactsName = change.forkName;
  }

  const git = gitHostFor(c.env);
  let upstreamToken: string;
  try {
    upstreamToken = (await git.mintToken(artifactsName, "read", READ_TOKEN_TTL_SEC)).token;
  } catch (e) {
    console.error("git proxy: minting a read token failed", artifactsName, e);
    return errorJson(502, "upstream", "the git backend is unavailable", "Retry in a moment.");
  }
  const remote = git.remoteOf(artifactsName).replace(/\/+$/, "");
  const target = isRefs
    ? `${remote}/info/refs?service=git-upload-pack`
    : `${remote}/git-upload-pack`;
  const headers = new Headers({ authorization: `Bearer ${upstreamToken}` });
  for (const h of [
    "git-protocol",
    "content-type",
    "content-encoding",
    "accept",
    "accept-encoding",
  ]) {
    const v = c.req.header(h);
    if (v) headers.set(h, v);
  }
  const ua = c.req.header("user-agent") ?? "";
  headers.set("user-agent", ua.startsWith("git/") ? ua : `git/gittifacts-proxy ${ua}`.trim());
  let res: Response;
  try {
    res = await fetch(target, {
      method: isRefs ? "GET" : "POST",
      headers,
      ...(isRefs ? {} : { body: c.req.raw.body }),
      redirect: "manual",
    });
  } catch (e) {
    console.error("git proxy: upstream fetch failed", e);
    return errorJson(502, "upstream", "the git backend is unavailable", "Retry in a moment.");
  }
  if (!res.ok) {
    await res.body?.cancel();
    if (res.status === 404) return repoNotFound();
    return errorJson(
      502,
      "upstream",
      `the git backend answered ${res.status}`,
      "Retry in a moment; if it persists, report it with the time of the request.",
    );
  }
  const out = new Headers({
    "cache-control": "no-cache, max-age=0, must-revalidate",
    expires: "Fri, 01 Jan 1980 00:00:00 GMT",
    pragma: "no-cache",
  });
  for (const h of ["content-type", "content-encoding"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers: out });
}
