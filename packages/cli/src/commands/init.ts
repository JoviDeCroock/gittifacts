/**
 * `gittifacts init`: one `create_project` call (repo + .platform/* + AGENTS.md + first CI + first
 * preview), then `.gittifacts.json` so later commands know the host and project. Works without an
 * account: the platform returns an unclaimed project, its own token (stored in credentials, not
 * in the project file) and a claim URL for a human.
 */
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { withCommands } from "../calls.js";
import { PROJECT_FILE, updateCredentials, writeProject } from "../config.js";
import { cliError, EXIT, usageError } from "../errors.js";
import { unknownTool } from "../failures.js";
import { clone, type GitAuth, splitRemote } from "../git.js";
import { callAnyTool } from "../mcp.js";
import { bundledCommands, IDEMPOTENCY_PROPERTY } from "../tools/commands.js";
import { isRecord, toWireTool } from "../tools/schema.js";
import { type Builtin, bool, builtinSpec, str } from "./builtin.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, resultDocument, toolFailure } from "./tool.js";

/** The launch templates (onboarding §3); the platform validates the id too. */
export const TEMPLATES = ["workers-api", "preact-app", "ts-library", "static-site"] as const;

const spec = builtinSpec({
  command: "init",
  tool: "create_project",
  title: "Create a project",
  description:
    "Create a project in one call (create_project): repo from a template or a GitHub import, .platform/ci.ts, policy and AGENTS.md, first CI and preview. Writes .gittifacts.json (host, projectId, remote). No account needed: you get an unclaimed project and a claim URL for a human.",
  mutating: true,
  properties: {
    template: { enum: [...TEMPLATES], description: "Start from a template." },
    from: { type: "string", description: "Import a GitHub repository (https URL)." },
    name: { type: "string", description: "Project name." },
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
      description: "Include the project token in the output (it is stored either way).",
    },
  },
});

interface ProjectResult {
  projectId: string;
  remoteUrl: string | null;
  remoteAuth: GitAuth | null;
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
  if (typeof doc.remote === "string") remoteUrl = doc.remote;
  else if (isRecord(doc.remote) && typeof doc.remote.url === "string") {
    remoteUrl = doc.remote.url;
    const user = s(doc.remote.username);
    const tok = s(doc.remote.token);
    if (tok)
      remoteAuth = user
        ? { scheme: "Basic", username: user, password: tok }
        : { scheme: "Bearer", token: tok };
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
    token: s(doc.token),
    tokenExpiresAt: s(doc.tokenExpiresAt) ?? s(doc.expiresAt),
    mcpUrl: s(doc.mcpUrl),
    claimUrl: s(doc.claimUrl),
  };
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
            "This directory already belongs to a project. Use it as-is, or pass --force to create a new project and overwrite the file.",
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
            explanation: `The project ${project.projectId} was created; clone it later once the platform reports a remote.`,
            command: "gittifacts whoami",
          },
          { details: redact(doc, false) },
        );
      }
      const dir = resolveDir(dirFlag ?? slug(name ?? project.projectId));
      const auth: GitAuth | null =
        project.remoteAuth ??
        (project.token
          ? { scheme: "Bearer", token: project.token }
          : target.token
            ? { scheme: "Bearer", token: target.token.token }
            : null);
      const res = await clone(ctx.io.git, { url: project.remoteUrl, dir, cwd: base, auth });
      if (res.code !== 0) {
        throw cliError(
          "clone-failed",
          `git clone failed (exit ${res.code}): ${res.stderr.trim().split("\n").at(-1) ?? ""}`,
          {
            explanation: `The project ${project.projectId} was created and its token stored; only the clone failed. Clone it yourself (the token goes in a header, not the URL).`,
            command: `git -c http.extraHeader="Authorization: Bearer <token>" clone ${project.remoteUrl} ${dir}`,
          },
          { details: redact(doc, false) },
        );
      }
      clonedTo = dir;
      configDir = dir;
    }
    const configPath = writeProject(configDir, {
      host: target.host,
      projectId: project.projectId,
      remote: project.remoteUrl ?? "",
      mcpUrl: project.mcpUrl ?? undefined,
    });

    const showToken = bool(parsed, "showToken");
    ctx.out.result(
      withCommands(
        {
          ...redact(doc, showToken),
          tokenStored: project.token !== null,
          config: configPath,
          ...(clonedTo ? { clonedTo } : {}),
          ...(project.token ? { credentialsPath: ctx.credentialsPath } : {}),
          idempotencyKey: key,
        },
        bundledCommands(),
      ),
      { title: `Project ${project.projectId} created` },
    );
    return EXIT.ok;
  },
};
