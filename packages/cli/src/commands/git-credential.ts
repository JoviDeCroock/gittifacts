/**
 * `gittifacts git-credential <get|store|erase>`: git's credential-helper protocol
 * (gitcredentials(7)), installed per clone by init --clone, clone, start-change and ship.
 *
 * `get` answers for two origins, read from `.gittifacts.json`:
 * - the current Change's fork (`remote`, `changeId`): a fresh token from refresh_push_token,
 *   as Basic `x:<token without ?expires=>` (the Artifacts remote rejects the suffix in Basic);
 * - the platform host itself (its read-only /git/ proxy, where `gittifacts clone` clones from):
 *   the login token (`x-access-token:<token>`), and only when the host is the CLI's target.
 * Anything else gets no answer, so git falls through to its other helpers. `store` and `erase`
 * are no-ops: every push asks for a fresh token, and nothing is ever written to disk.
 *
 * stdout carries the protocol only; every message goes to stderr (git shows it).
 */

import { basicPassword, originOf, parsePushRemote } from "../clone-setup.js";
import { normalizeHost } from "../config.js";
import type { Ctx } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import { findCommand } from "../tools/commands.js";
import { callTool } from "./tool.js";

/** `key=value` lines up to a blank line. */
export function parseCredentialRequest(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "") break;
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).replace(/\r$/, "");
  }
  return out;
}

function answer(fields: Record<string, string | undefined>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== "" && !/[\n\0]/.test(v))
    .map(([k, v]) => `${k}=${v}`);
  return `${lines.join("\n")}\n`;
}

function expiryUtc(expiresAt: string): string | undefined {
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) ? String(Math.floor(t / 1000)) : undefined;
}

function say(ctx: Ctx, line: string): void {
  ctx.io.stderr.write(`gittifacts: ${line}\n`);
}

async function get(ctx: Ctx, req: Record<string, string>): Promise<number> {
  if (!req.protocol || !req.host) return EXIT.ok;
  const asked = `${req.protocol}://${req.host}`;
  const found = ctx.project();
  if (!found) return EXIT.ok;
  const cfg = found.config;
  const target = ctx.target();
  const platform = normalizeHost(cfg.host) === asked && target.host === asked;
  const fork = cfg.remote !== "" && originOf(cfg.remote) === asked && !platform;
  if (fork && !cfg.changeId) {
    say(
      ctx,
      `${found.path} names no Change to push to. Run \`gittifacts ship\` instead of git push.`,
    );
    return EXIT.error;
  }
  if (fork && cfg.changeId) {
    const spec = findCommand("refresh_push_token");
    if (!spec) return EXIT.error;
    const doc = await callTool(
      ctx,
      target,
      spec,
      { changeId: cfg.changeId },
      {
        idempotencyKey: ctx.newIdempotencyKey(),
      },
    );
    const remote = parsePushRemote(doc.remote);
    if (!remote) {
      say(ctx, "refresh_push_token returned no token; retry, or run `gittifacts ship`.");
      return EXIT.error;
    }
    ctx.io.stdout.write(
      answer({
        username: remote.username,
        password: basicPassword(remote.token),
        password_expiry_utc: expiryUtc(remote.expiresAt),
      }),
    );
    return EXIT.ok;
  }
  // The login token only ever goes to the platform itself (its /git/ proxy), never to an
  // origin a project file names.
  if (!platform) return EXIT.ok;
  if (!target.token) {
    say(ctx, `no token for ${target.host}. Run \`gittifacts login --host ${target.host}\`.`);
    return EXIT.error;
  }
  ctx.io.stdout.write(answer({ username: "x-access-token", password: target.token.token }));
  return EXIT.ok;
}

/** Runs the helper; never prints the CLI's JSON envelope on stdout (git would parse it). */
export async function gitCredential(ctx: Ctx, action: string | undefined): Promise<number> {
  const text = await ctx.io.readStdin();
  if (action !== "get") return EXIT.ok;
  try {
    return await get(ctx, parseCredentialRequest(text));
  } catch (e) {
    if (e instanceof CliError) {
      const { message, fix } = e.body;
      say(ctx, `couldn't get a git token: ${message}`);
      say(ctx, fix.command ? `${fix.explanation} Run: ${fix.command}` : fix.explanation);
      return e.exitCode;
    }
    say(ctx, `couldn't get a git token: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.error;
  }
}
