/**
 * `gittifacts init`: one `create_project` call (repo + .platform/* + AGENTS.md + first CI + first
 * preview), then `.gittifacts.json` so later commands know the host and project. Works without an
 * account: the platform returns an unclaimed project, its own token (stored in credentials, not
 * in the project file) and a claim URL for a human.
 */
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { withCommands } from "../calls.js";
import { adoptChange, installHelper, type WiringResult } from "../clone-setup.js";
import { PROJECT_FILE, updateCredentials, writeProject } from "../config.js";
import type { Ctx, Target } from "../context.js";
import { cliError, EXIT, usageError } from "../errors.js";
import { unknownTool } from "../failures.js";
import { clone, type GitAuth, splitRemote } from "../git.js";
import { callAnyTool } from "../mcp.js";
import { isCachedBuild, TARBALL_PATH } from "../self-update.js";
import { bundledCommands, IDEMPOTENCY_PROPERTY } from "../tools/commands.js";
import { isRecord, toWireTool } from "../tools/schema.js";
import { type Builtin, bool, builtinSpec, str } from "./builtin.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, resultDocument, toolFailure } from "./tool.js";

/** The launch templates (onboarding §3); the platform validates the id too. */
export const TEMPLATES = ["workers-api", "preact-app", "ts-library", "static-site"] as const;

const spec = builtinSpec({
  command: "init",
  tool: "create_project",
  title: "Create a repo",
  description:
    "Create a repo in one call (create_project): repo from a template or a GitHub import, .platform/ci.ts, policy and AGENTS.md, first CI and preview. Writes .gittifacts.json (host, projectId, remote, changeId; no secrets). With --clone, plain git push then goes to the first Change's fork (credential helper). No account needed: you get an unclaimed repo and a claim URL for a human.",
  mutating: true,
  properties: {
    template: { enum: [...TEMPLATES], description: "Start from a template." },
    from: { type: "string", description: "Import a GitHub repository (https URL)." },
    name: { type: "string", description: "Repo name." },
    description: { type: "string", description: "One-line description." },
    clone: {
      type: "boolean",
      description:
        "git clone the new repo (the token travels in git's environment, never in .git/config).",
    },
    dir: {
      type: "string",
      description:
        "Where to write .gittifacts.json (default: cwd), or clone to with --clone (default: ./<name>).",
    },
    force: { type: "boolean", description: "Overwrite an existing .gittifacts.json." },
    showToken: {
      type: "boolean",
      description: "Include the repo token in the output (it is stored either way).",
    },
  },
});

interface ProjectResult {
  projectId: string;
  remoteUrl: string | null;
  remoteAuth: GitAuth | null;
  /** The bootstrap Change whose fork `remote` is (refresh_push_token mints its git token). */
  remoteChangeId: string | null;
  token: string | null;
  tokenExpiresAt: string | null;
  mcpUrl: string | null;
  claimUrl: string | null;
}

/** Validates the parts of the create_project result the CLI relies on (external input). */
export function parseProjectResult(doc: Record<string, unknown>): ProjectResult {
  if (typeof doc.projectId !== "string" || doc.projectId === "") {
    throw cliError(
      "invalid-response",
      "create_project returned no projectId",
      {
        explanation:
          "The platform answered with an unexpected shape. Retry with the same --idempotency-key; if it persists, report it.",
      },
      { details: doc },
    );
  }
  const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  let remoteUrl: string | null = null;
  let remoteAuth: GitAuth | null = null;
  let remoteChangeId: string | null = null;
  if (typeof doc.remote === "string") remoteUrl = doc.remote;
  else if (isRecord(doc.remote) && typeof doc.remote.url === "string") {
    remoteUrl = doc.remote.url;
    const tok = s(doc.remote.token);
    // Artifacts tokens carry an `?expires=` suffix that Basic auth rejects; Bearer takes the
    // whole token, so always use it (remote.username is only a placeholder).
    if (tok) remoteAuth = { scheme: "Bearer", token: tok };
    remoteChangeId = s(doc.remote.changeId);
  }
  if (remoteUrl) {
    const split = splitRemote(remoteUrl);
    remoteUrl = split.url;
    remoteAuth ??= split.auth;
  }
  return {
    projectId: doc.projectId,
    remoteUrl,
    remoteAuth,
    remoteChangeId,
    token: s(doc.token),
    tokenExpiresAt: s(doc.tokenExpiresAt) ?? s(doc.expiresAt),
    mcpUrl: s(doc.mcpUrl),
    claimUrl: s(doc.claimUrl),
  };
}

/**
 * The platform's first step for a credential-less create_project is "reconnect with the token"
 * (an MCP session stays anonymous). The CLI already stored the token and sends it on every later
 * command, so that step is noise here and would push the bootstrap wait out of nextSteps[0]
 * (journey 10; /start and the README promise the wait comes first).
 */
export function withoutReconnectStep(doc: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(doc.nextSteps)) return doc;
  const steps = doc.nextSteps.filter(
    (s) => !(isRecord(s) && typeof s.title === "string" && /^Reconnect\b/.test(s.title)),
  );
  return steps.length === doc.nextSteps.length ? doc : { ...doc, nextSteps: steps };
}

/** Removes secrets from what gets printed. */
function redact(doc: Record<string, unknown>, showToken: boolean): Record<string, unknown> {
  const out = { ...doc };
  if (!showToken && typeof out.token === "string") delete out.token;
  if (isRecord(out.remote)) {
    const { token: _t, ...rest } = out.remote;
    out.remote = showToken ? out.remote : rest;
  } else if (typeof out.remote === "string") out.remote = splitRemote(out.remote).url;
  return out;
}

/** `url`'s origin, or null for a path or scp-style remote. */
function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Git auth for a remote the platform returned without a token. The platform token (login or the
 * unclaimed project's) is only ever sent to the platform's own origin: on another origin (the
 * Artifacts git host) the CLI asks the platform for the Change's push token instead, and clones
 * without auth when it can't get one (the clone then fails with a fix that names the call).
 */
async function fallbackAuth(
  ctx: Ctx,
  target: Target,
  project: ProjectResult,
): Promise<GitAuth | null> {
  const platformToken = project.token ?? target.token?.token ?? null;
  if (platformToken === null || project.remoteUrl === null) return null;
  if (originOf(project.remoteUrl) === target.host)
    return { scheme: "Bearer", token: platformToken };
  if (project.remoteChangeId === null) return null;
  const changeId = project.remoteChangeId;
  const as: Target = {
    ...target,
    token: {
      token: platformToken,
      source: project.token ? "project" : (target.token?.source ?? "env"),
      expiresAt: null,
    },
  };
  try {
    const doc = await ctx.withConnection(as, "init", {}, async ({ mcp }) => {
      const r = await callAnyTool(
        mcp,
        "refresh_push_token",
        { changeId },
        { timeout: DEFAULT_REQUEST_TIMEOUT_MS },
      );
      return r.isError ? null : resultDocument(r);
    });
    const remote = doc && isRecord(doc.remote) ? doc.remote : null;
    // Only for the host we are about to clone from: a token minted for another host is not sent.
    if (remote === null || typeof remote.token !== "string" || remote.token === "") return null;
    if (typeof remote.url !== "string" || originOf(remote.url) !== originOf(project.remoteUrl))
      return null;
    return { scheme: "Bearer", token: remote.token };
  } catch {
    return null;
  }
}

/**
 * What a person at a terminal needs, in at most six lines: the repo, its preview, the claim link
 * and the one next step. The JSON document (piped, --json) is unchanged.
 */
export function initText(
  doc: Record<string, unknown>,
  project: ProjectResult,
  clonedTo: string | undefined,
  cwd: string,
  /** How this CLI was run, when it isn't on PATH as `gittifacts` (an npx tarball URL). */
  npx: string | null = null,
): string {
  const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const name = s(doc.name);
  const lines = [`Created repo ${name ? `${name} (${project.projectId})` : project.projectId}`];
  const preview = s(doc.previewUrl);
  if (preview) lines.push(`Preview: ${preview} (live once the first CI run is green)`);
  if (project.claimUrl)
    lines.push(`Claim it to keep it (unclaimed repos expire): ${project.claimUrl}`);
  if (clonedTo) {
    const rel = relative(cwd, clonedTo) || ".";
    lines.push(`Cloned into ${rel}. Next: edit a file, commit, then ship it:`);
    lines.push(`  $ cd ${rel} && git commit -am "<what changed>" && gittifacts ship`);
    if (npx) lines.push(`  (no gittifacts on PATH? alias gittifacts="npx -y ${npx}")`);
  } else {
    const step = Array.isArray(doc.nextSteps) ? doc.nextSteps.find(isRecord) : undefined;
    const command = s(step?.command);
    lines.push(`Next: ${s(step?.title) ?? "wait for the first CI run"}`);
    if (command) lines.push(`  $ ${command}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The tarball URL when this bundle runs from npx's cache (or a build it updated itself to). */
function npxSource(script: string | null, host: string): string | null {
  if (script === null) return null;
  return /[\\/]_npx[\\/]/.test(script) || isCachedBuild(script) ? `${host}${TARBALL_PATH}` : null;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

export const init: Builtin = {
  spec,
  examples: [
    "gittifacts init --template workers-api --name my-api",
    "gittifacts init --template preact-app --name app --clone",
    "gittifacts init --from https://github.com/org/repo",
  ],
  async run(ctx, parsed) {
    const template = str(parsed, "template");
    const from = str(parsed, "from");
    const name = str(parsed, "name");
    const description = str(parsed, "description");
    const wantClone = bool(parsed, "clone");
    const fix = {
      explanation: `Usage: gittifacts init [--template ${TEMPLATES.join("|")}] [--from <githubUrl>] [--name <name>]`,
      command: "gittifacts init --help",
    };
    if (parsed.positionals.length > 0)
      throw usageError(`unexpected arguments: ${parsed.positionals.join(" ")}`, fix);
    if (template && from) throw usageError("pass --template or --from, not both", fix);
    if (from && !/^https?:\/\//i.test(from))
      throw usageError(`--from must be an https URL, got ${JSON.stringify(from)}`, fix);

    const dirFlag = str(parsed, "dir");
    const base = ctx.io.cwd;
    const resolveDir = (d: string) => (isAbsolute(d) ? d : resolve(base, d));
    // Without --clone the project file goes in --dir (or the cwd); check before creating anything.
    if (!wantClone) {
      const configPath = join(resolveDir(dirFlag ?? "."), PROJECT_FILE);
      if (existsSync(configPath) && !bool(parsed, "force")) {
        throw cliError("already-initialized", `${configPath} already exists`, {
          explanation:
            "This directory already belongs to a repo. Use it as-is, or pass --force to create a new repo and overwrite the file.",
          command: "gittifacts whoami",
        });
      }
    } else if (dirFlag) {
      const d = resolveDir(dirFlag);
      if (existsSync(d) && readdirSync(d).length > 0) {
        throw usageError(`${d} exists and is not empty; git can't clone into it`, {
          explanation: "Pick a new --dir for the clone.",
          command: "gittifacts init --help",
        });
      }
    }

    const target = ctx.target();
    const key = ctx.globals.idempotencyKey ?? ctx.newIdempotencyKey();
    const doc = await ctx.withConnection(
      target,
      "init",
      { headers: { "Idempotency-Key": key }, meta: { idempotencyKey: key } },
      async ({ mcp }) => {
        // The platform is adding create_project; check it's there for a clean error, and send the
        // idempotency key as an argument only if its schema declares one.
        const tools = (await mcp.listTools()).map(toWireTool);
        const tool = tools.find((t) => t?.name === "create_project");
        if (!tool) throw unknownTool(ctx.failureContext(target, "init"), "create_project");
        const declared = tool.inputSchema.properties ?? {};
        const args = {
          ...(name !== undefined ? { name } : {}),
          ...(template !== undefined ? { template } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(IDEMPOTENCY_PROPERTY in declared ? { idempotencyKey: key } : {}),
        };
        const r = await callAnyTool(mcp, "create_project", args, {
          timeout: DEFAULT_REQUEST_TIMEOUT_MS,
        });
        if (r.isError) throw toolFailure(spec, r);
        return resultDocument(r);
      },
    );

    const project = parseProjectResult(doc);
    const now = new Date(ctx.io.now()).toISOString();
    if (project.token) {
      const token = project.token;
      updateCredentials(ctx.credentialsPath, (c) => {
        const h = c.hosts[target.host] ?? {};
        c.hosts[target.host] = h;
        h.projects = {
          ...h.projects,
          [project.projectId]: {
            token,
            expiresAt: project.tokenExpiresAt,
            claimUrl: project.claimUrl,
            createdAt: now,
          },
        };
      });
      ctx.invalidate();
    }

    let configDir = resolveDir(dirFlag ?? ".");
    let clonedTo: string | undefined;
    if (wantClone) {
      if (!project.remoteUrl) {
        throw cliError(
          "clone-failed",
          "create_project returned no git remote to clone",
          {
            explanation: `The repo ${project.projectId} was created; clone it later once the platform reports a remote.`,
            command: "gittifacts whoami",
          },
          { details: redact(doc, false) },
        );
      }
      const dir = resolveDir(dirFlag ?? slug(name ?? project.projectId));
      const auth = project.remoteAuth ?? (await fallbackAuth(ctx, target, project));
      const res = await clone(ctx.io.git, { url: project.remoteUrl, dir, cwd: base, auth });
      if (res.code !== 0 && auth === null) {
        throw cliError(
          "clone-failed",
          `git clone failed (exit ${res.code}): ${res.stderr.trim().split("\n").at(-1) ?? ""}`,
          {
            explanation: `The repo ${project.projectId} was created and its token stored; only the clone failed. The platform returned no git token for ${project.remoteUrl}, and the CLI does not send your platform token to another origin. Ask for a push token for the first Change, then clone with it in a header.`,
            ...(project.remoteChangeId
              ? {
                  call: `refresh_push_token({ changeId: "${project.remoteChangeId}" })`,
                  command: `gittifacts refresh-push-token --change-id ${project.remoteChangeId}`,
                }
              : { command: "gittifacts list-repos" }),
          },
          { details: redact(doc, false) },
        );
      }
      if (res.code !== 0) {
        throw cliError(
          "clone-failed",
          `git clone failed (exit ${res.code}): ${res.stderr.trim().split("\n").at(-1) ?? ""}`,
          {
            explanation: `The repo ${project.projectId} was created and its token stored; only the clone failed. Clone it yourself (the token goes in a header, not the URL).`,
            command: `git -c http.extraHeader="Authorization: Bearer <token>" clone ${project.remoteUrl} ${dir}`,
          },
          { details: redact(doc, false) },
        );
      }
      clonedTo = dir;
      configDir = dir;
    }
    const projectConfig = {
      host: target.host,
      projectId: project.projectId,
      remote: project.remoteUrl ?? "",
      mcpUrl: project.mcpUrl ?? undefined,
    };
    const configPath = writeProject(configDir, projectConfig);
    // The clone pushes to the first Change's fork with plain `git push` (credential helper).
    let git: WiringResult | undefined;
    if (clonedTo && project.remoteUrl) {
      const branch =
        isRecord(doc.remote) && typeof doc.remote.branch === "string" ? doc.remote.branch : "main";
      try {
        git = project.remoteChangeId
          ? await adoptChange(ctx.io, {
              dir: clonedTo,
              projectDir: clonedTo,
              config: projectConfig,
              changeId: project.remoteChangeId,
              remote: { url: project.remoteUrl, branch },
            })
          : undefined;
        if (!git) await installHelper(ctx.io, clonedTo, target.host, []);
      } catch (e) {
        ctx.out.notice(
          `gittifacts: cloned, but couldn't set up git push: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const showToken = bool(parsed, "showToken");
    const shown = project.token !== null ? withoutReconnectStep(doc) : doc;
    const printed = withCommands(
      {
        ...redact(shown, showToken),
        tokenStored: project.token !== null,
        config: configPath,
        ...(clonedTo ? { clonedTo } : {}),
        ...(git ? { git } : {}),
        ...(project.token ? { credentialsPath: ctx.credentialsPath } : {}),
        idempotencyKey: key,
      },
      bundledCommands(),
    );
    ctx.out.result(printed, {
      title: `Repo ${project.projectId} created`,
      text: initText(printed, project, clonedTo, base, npxSource(ctx.io.self.script, target.host)),
    });
    return EXIT.ok;
  },
};
