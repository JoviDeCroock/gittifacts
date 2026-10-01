/**
 * Structural mirrors of the `@cloudflare/ci@0.2.0` types the adapter uses. They are declared here
 * so that the strictly-checked modules never import `@cloudflare/ci` (whose TypeScript source does
 * not pass this repo's compiler flags). `workflow.ts`, checked by `tsconfig.cloudflare.json`
 * against the real package, asserts both directions of compatibility.
 */

export type CfLogs = {
  stdout: string | ReadableStream<Uint8Array>;
  stderr: string | ReadableStream<Uint8Array>;
};

/** `RunnerOptions` (the subset the adapter sets). */
export type CfRunnerOptions = {
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  cache?: { inputs: string[] };
  config?: {
    retries?: { limit: number; delay: number; backoff?: "constant" | "linear" | "exponential" };
    timeout?: number;
    commandTimeoutMs?: number;
  };
  sourceControlCredentials?: boolean;
};

/** `CiRunnerResult`. */
export type CfRunnerResult = {
  exitCode: number;
  logs: CfLogs;
  snapshot: { id: string; dir: string; localBucket?: boolean };
  runner(options: CfRunnerOptions): Promise<CfRunnerResult>;
};

/** `CiContext`. */
export type CfCiContext = {
  runner(options: CfRunnerOptions): Promise<CfRunnerResult>;
};

/** `CiParams<CloudflareArtifacts>`, plus our request riding along. */
export type CfCiParams<G = unknown> = {
  provider: "cloudflare-artifacts";
  providerData: { namespace: string };
  event: { type: "push" } | { type: "tag" };
  owner: string;
  repo: string;
  sha: string;
  remote?: "cloudflare";
  trigger: "push" | "tag";
  ref: string;
  branch?: string;
  beforeSha?: string;
  actor?: string;
  /** The validated `RunRequest` (CIWorkflow passes extra fields through untouched). */
  gittifacts: G;
};
