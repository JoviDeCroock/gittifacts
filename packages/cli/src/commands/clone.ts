/**
 * `gittifacts clone <repoId> [--dir <d>]`: clone a repo you can read through the platform's
 * read-only git proxy (`https://<host>/git/<owner>/<repo>.git`) with your login token, write
 * `.gittifacts.json` and install the credential helper. `gittifacts ship` then starts a Change
 * and points `origin` at its fork. The repo page shows this exact command.
 *
 * The proxy serves claimed repos only, to tokens with repo:read (a login, not an unclaimed
 * repo's own token); when it can't serve you the error says what to do instead.
 */
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { installHelper, originOf } from "../clone-setup.js";
import { writeProject } from "../config.js";
import type { Ctx, Target } from "../context.js";
import { cliError, EXIT, usageError } from "../errors.js";
import { clone as gitClone } from "../git.js";
import { findCommand } from "../tools/commands.js";
import { isRecord } from "../tools/schema.js";
import { type Builtin, builtinSpec, positionalOr, requireValue, str } from "./builtin.js";
import { callTool } from "./tool.js";

const spec = builtinSpec({
  command: "clone",
  tool: "list_repos",
  title: "Clone a repo",
  description:
    "git clone a repo you can read (the platform's read-only /git/ proxy, with your login token), write .gittifacts.json and install the credential helper. Then edit, commit and run `gittifacts ship`.",
  properties: {
    repoId: { type: "string", description: "The repo (from list-repos or the repo page)." },
    dir: { type: "string", description: "Where to clone (default ./<repo name>)." },
    url: {
      type: "string",
      description: "The repo's /git/ URL, when the platform doesn't report one.",
    },
  },
  required: ["repoId"],
  positional: "repoId",
});

interface RepoRow {
  id: string;
  name: string;
  claimed: boolean;
  cloneUrl: string | null;
}

/** The repo from list_repos (external input): its name, claim and git URL, if reported. */
async function findRepo(ctx: Ctx, target: Target, repoId: string): Promise<RepoRow | null> {
  const list = findCommand("list_repos");
  if (!list) return null;
  const doc = await callTool(ctx, target, list, {});
  const repos = Array.isArray(doc.repos) ? doc.repos.filter(isRecord) : [];
  const r = repos.find((x) => x.id === repoId);
  if (!r) return null;
  const url = [r.cloneUrl, r.gitUrl].find((u) => typeof u === "string" && u !== "");
  return {
    id: repoId,
    name: typeof r.name === "string" && r.name !== "" ? r.name : repoId,
    claimed: !isRecord(r.claim) || r.claim.status !== "unclaimed",
    cloneUrl: typeof url === "string" ? url : null,
  };
}

function cloneUrlFor(
  ctx: Ctx,
  target: Target,
  repoId: string,
  repo: RepoRow | null,
  flag?: string,
): string {
  if (flag) {
    if (originOf(flag) !== target.host) {
      throw usageError(`--url must be on ${target.host}, got ${flag}`, {
        explanation: "Your login token is only ever sent to the platform host.",
        command: `gittifacts clone ${repoId} --url ${target.host}/git/<owner>/<repo>.git`,
      });
    }
    return flag;
  }
  if (!repo) {
    throw cliError("not-found", `you can't read repo ${repoId}`, {
      explanation: "It doesn't exist, or your login has no access. List the repos you can read.",
      call: "list_repos({})",
      command: "gittifacts list-repos",
    });
  }
  if (!repo.claimed) {
    throw cliError(
      "unclaimed",
      `repo ${repoId} is unclaimed, and the read-only git proxy serves claimed repos only`,
      {
        explanation:
          "Claim it (the claim link from init) to keep it and clone it here. Or work in a Change's fork: start one, then clone its remote.url with the push token.",
        call: `start_change({ repoId: "${repoId}", title: "<what>", category: "feature" })`,
        command: `gittifacts start-change --repo-id ${repoId} --title '<what>' --category feature`,
      },
    );
  }
  if (!repo.cloneUrl || originOf(repo.cloneUrl) !== target.host) {
    throw cliError("no-clone-url", `${target.host} doesn't report a git URL for ${repoId}`, {
      explanation: `The read-only URL is ${target.host}/git/<owner>/${repo.name}.git (<owner> is the owner's handle, shown on the repo page). Pass it with --url.`,
      command: `gittifacts clone ${repoId} --url ${target.host}/git/<owner>/${repo.name}.git`,
    });
  }
  return repo.cloneUrl;
}

export const clone: Builtin = {
  spec,
  examples: ["gittifacts clone repo_123", "gittifacts clone repo_123 --dir work"],
  async run(ctx, parsed) {
    const repoId = requireValue(spec, positionalOr(spec, parsed, "repoId"), "<repoId>");
    const target = ctx.target();
    if (!target.token || target.token.source === "project") {
      throw cliError("unauthorized", "clone needs your login (a token with repo:read)", {
        explanation:
          "The read-only git proxy takes a login token, not an unclaimed repo's own token.",
        command: `gittifacts login --host ${target.host}`,
      });
    }
    const flag = str(parsed, "url");
    const repo = flag ? null : await findRepo(ctx, target, repoId);
    const url = cloneUrlFor(ctx, target, repoId, repo, flag);
    const name =
      repo?.name ??
      url
        .replace(/\.git$/, "")
        .split("/")
        .at(-1) ??
      repoId;
    const base = ctx.io.cwd;
    const dirFlag = str(parsed, "dir");
    const dir = dirFlag
      ? isAbsolute(dirFlag)
        ? dirFlag
        : resolve(base, dirFlag)
      : resolve(base, name);
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      throw usageError(`${dir} exists and is not empty; git can't clone into it`, {
        explanation: "Pick a new --dir for the clone.",
        command: `gittifacts clone ${repoId} --dir <new-dir>`,
      });
    }
    ctx.out.progress(`cloning ${url}`);
    const res = await gitClone(ctx.io.git, {
      url,
      dir,
      cwd: base,
      auth: { scheme: "Bearer", token: target.token.token },
    });
    if (res.code !== 0) {
      const last = res.stderr.trim().split("\n").at(-1) ?? "";
      throw cliError("clone-failed", `git clone failed (exit ${res.code}): ${last}`, {
        explanation: /40[13]|denied|unauthorized/i.test(res.stderr)
          ? "The proxy refused your token: it needs repo:read and the HTTP API audience (a device-flow login has both). Log in again."
          : "Read git's message and retry.",
        command: `gittifacts login --host ${target.host}`,
      });
    }
    const config = writeProject(dir, {
      host: target.host,
      projectId: repoId,
      remote: url,
      cloneUrl: url,
    });
    const helper = await installHelper(ctx.io, dir, target.host, [target.host]);
    ctx.out.result(
      {
        repoId,
        clonedTo: dir,
        cloneUrl: url,
        config,
        git: { remote: "origin", url, credentialHelper: helper },
        nextStep: { title: "Edit, commit, then ship it", command: "gittifacts ship" },
      },
      {
        text: `Cloned ${repoId} into ${dir}\nNext: edit, commit, then\n  $ cd ${dir} && gittifacts ship\n`,
      },
    );
    return EXIT.ok;
  },
};
