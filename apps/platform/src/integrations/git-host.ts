/**
 * The git host the proxy mints short-lived Artifacts read tokens from, swappable for tests
 * (Artifacts has no local simulator).
 */
import type { GitHost } from "@app/coordinator";
import { buildPorts, type PortsEnv } from "../runtime/ports.js";

export type GitHostFactory = (env: unknown) => Pick<GitHost, "mintToken" | "remoteOf">;

let gitHostFactory: GitHostFactory = (env) => buildPorts(env as PortsEnv, "default").git;

/** Tests: Artifacts has no local simulator, so the proxy's token minting is swapped for a fake. */
export function configureIntegrationGitHost(factory: GitHostFactory): void {
  gitHostFactory = factory;
}

export function gitHostFor(env: unknown): Pick<GitHost, "mintToken" | "remoteOf"> {
  return gitHostFactory(env);
}
