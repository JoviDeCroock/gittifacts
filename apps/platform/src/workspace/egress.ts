/**
 * Egress for remote workspaces of `registries-only` projects (every unclaimed project, and claimed
 * ones whose policy asks for it). It reuses the CI engine's policy (`egressDecision` +
 * `REGISTRY_HOSTS`: GET/HEAD to the npm/yarn registries and codeload.github.com, git fetch from the
 * repository's git host) and adds exactly one thing CI never needs: `git push` to the workspace's
 * own fork (receive-pack on that one repository path). The push still needs the fork-only token,
 * which only the commit-push exec holds; this rule just keeps the gateway from blocking it.
 *
 * The container reaches this entrypoint through `ctx.exports.WorkspaceEgressGateway({ props })`
 * (`interceptAllOutboundHttp` + `interceptOutboundHttps("*")`, internet off). Refused requests get a
 * 403 whose body tells the agent why, and are counted on the Workspace Durable Object.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { egressDecision } from "@app/ci-engine";
import { z } from "zod";

export type EgressDecision = { allowed: true } | { allowed: false; reason: string };

/** A URL without its query string or credentials, for logs and the 403 body. */
function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300);
  } catch {
    return "(invalid url)";
  }
}

const Host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/i);

export const WorkspaceEgressProps = z
  .object({
    workspaceId: z.string().min(1).max(100),
    registries: z.array(Host).max(32),
    gitHost: Host.nullable(),
    /** `/git/<namespace>/<fork>.git`: the only repository the workspace may push to. */
    pushPath: z
      .string()
      .regex(/^\/[A-Za-z0-9._/-]+\.git$/)
      .nullable(),
  })
  .strict();
export type WorkspaceEgressProps = z.infer<typeof WorkspaceEgressProps>;

export function workspaceEgressDecision(
  method: string,
  url: string,
  props: Pick<WorkspaceEgressProps, "registries" | "gitHost" | "pushPath">,
): EgressDecision {
  const base = egressDecision(method, url, props);
  if (base.allowed || props.gitHost === null || props.pushPath === null) return base;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return base;
  }
  if (u.hostname.toLowerCase() !== props.gitHost) return base;
  const m = method.toUpperCase();
  if (m === "GET" && u.pathname === `${props.pushPath}/info/refs`) {
    return u.searchParams.get("service") === "git-receive-pack" ? { allowed: true } : base;
  }
  if (m === "POST" && u.pathname === `${props.pushPath}/git-receive-pack`) return { allowed: true };
  return base;
}

export interface WorkspaceEgressEnv {
  WORKSPACE?: {
    getByName(name: string): {
      noteEgressDenied(denial: { method: string; url: string; reason: string }): Promise<unknown>;
    };
  };
}

export class WorkspaceEgressGateway extends WorkerEntrypoint<WorkspaceEgressEnv, unknown> {
  override async fetch(request: Request): Promise<Response> {
    const props = WorkspaceEgressProps.safeParse(this.ctx.props);
    if (!props.success) {
      return new Response("gittifacts: workspace egress gateway misconfigured\n", { status: 500 });
    }
    const decision = workspaceEgressDecision(request.method, request.url, props.data);
    if (decision.allowed) return fetch(request);
    const denial = {
      method: request.method.slice(0, 16),
      url: describeUrl(request.url),
      reason: decision.reason.slice(0, 300),
    };
    try {
      await this.env.WORKSPACE?.getByName(props.data.workspaceId).noteEgressDenied(denial);
    } catch {
      // best effort; refused either way
    }
    return new Response(
      `gittifacts: outbound ${denial.method} ${denial.url} blocked (${denial.reason}). ` +
        `This project's workspace may only reach package registries (${props.data.registries.join(", ")}) ` +
        "and its own fork. Claim the project for open egress.\n",
      { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
}
