/**
 * Egress policy for `network: "registries-only"`. Runtime-agnostic.
 *
 * How it is enforced (verified against the Containers docs on 2026-10-01): the container starts
 * with `enableInternet: false`; `interceptAllOutboundHttp(gw)` and `interceptOutboundHttps("*", gw)`
 * send every HTTP and HTTPS request to `CiEgressGateway`; DNS for anything else times out and no
 * other connection has a route. HTTPS interception terminates TLS with a Cloudflare CA that the
 * container must trust (`CONTAINERS_CA_PATH`), which the Runner installs before the first exec.
 */
import { z } from "zod";

/** Package registries reachable under `registries-only` (GET/HEAD only). */
export const REGISTRY_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  // Yarn Berry/corepack release downloads.
  "repo.yarnpkg.com",
  // GitHub tarball dependencies.
  "codeload.github.com",
];

/** Name the platform Worker must export the gateway entrypoint under. */
export const EGRESS_GATEWAY_EXPORT = "CiEgressGateway";

/** Where the Containers runtime puts the interception CA certificate. */
export const CONTAINERS_CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

const Host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/i, "a bare hostname");

export const EgressProps = z
  .object({
    /** Runner Durable Object name (`runId:step`) to report denials to. */
    runner: z.string().min(1).max(200),
    registries: z.array(Host).max(32),
    /** The repository's git host; fetch-only (`info/refs` + `git-upload-pack`). */
    gitHost: Host.nullable(),
  })
  .strict();
export type EgressProps = z.infer<typeof EgressProps>;

export type EgressDecision = { allowed: true } | { allowed: false; reason: string };

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** A URL without its query string or credentials, for logs. */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300);
  } catch {
    return "(invalid url)";
  }
}

export function egressDecision(
  method: string,
  url: string,
  props: Pick<EgressProps, "registries" | "gitHost">,
): EgressDecision {
  const host = hostOf(url);
  if (host === null) return { allowed: false, reason: "invalid URL" };
  const m = method.toUpperCase();
  if (props.registries.includes(host)) {
    return m === "GET" || m === "HEAD"
      ? { allowed: true }
      : { allowed: false, reason: `${m} to a registry` };
  }
  if (props.gitHost !== null && host === props.gitHost) {
    const path = new URL(url).pathname;
    if (m === "GET" && path.endsWith("/info/refs")) {
      const service = new URL(url).searchParams.get("service");
      return service === null || service === "git-upload-pack"
        ? { allowed: true }
        : { allowed: false, reason: `git service ${service}` };
    }
    if (m === "POST" && path.endsWith("/git-upload-pack")) return { allowed: true };
    return { allowed: false, reason: `${m} ${path} on the git host (fetch only)` };
  }
  return { allowed: false, reason: `${host} is not an allowed registry` };
}

export const EgressDenial = z.object({
  method: z.string().max(16),
  url: z.string().max(300),
  reason: z.string().max(300),
});
export type EgressDenial = z.infer<typeof EgressDenial>;
