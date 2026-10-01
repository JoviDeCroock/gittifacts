/**
 * Content-addressed cache keys. A key changes when anything that could change the step's
 * resulting filesystem changes: the cache scope, the step's name/command/cwd/env, the input globs
 * and the git blob SHAs they match at the head commit.
 */
import { compileGlobs } from "./glob.js";
import type { TreeBlob } from "./tree.js";

export const CACHE_KEY_VERSION = 1;

export interface CacheKeyInput {
  /** Who may reuse the snapshot (see `CacheScopes`). */
  scope: string;
  /** Operator-controlled salt; bump it when the runner image changes. */
  namespace: string;
  step: {
    name: string;
    command: string;
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
  };
  inputs: readonly string[];
  blobs: readonly TreeBlob[];
}

export function matchBlobs(blobs: readonly TreeBlob[], inputs: readonly string[]): TreeBlob[] {
  const match = compileGlobs(inputs);
  return blobs.filter((b) => match(b.path));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The canonical string that is hashed. Exposed for tests and debugging. */
export function cacheKeyMaterial(input: CacheKeyInput, matched: readonly TreeBlob[]): string {
  return JSON.stringify({
    v: CACHE_KEY_VERSION,
    namespace: input.namespace,
    scope: input.scope,
    step: input.step.name,
    command: input.step.command,
    cwd: input.step.cwd ?? null,
    env: Object.entries(input.step.env ?? {}).sort(([a], [b]) => byString(a, b)),
    inputs: [...new Set(input.inputs)].sort(byString),
    files: [...matched].sort((a, b) => byString(a.path, b.path)).map((b) => [b.path, b.sha]),
  });
}

/** sha256 hex key, or null when no file matches the inputs (an unkeyable step is not cached). */
export async function computeCacheKey(input: CacheKeyInput): Promise<string | null> {
  const matched = matchBlobs(input.blobs, input.inputs);
  if (matched.length === 0) return null;
  return sha256Hex(cacheKeyMaterial(input, matched));
}
