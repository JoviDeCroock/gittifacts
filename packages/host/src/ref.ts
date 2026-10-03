/**
 * `ChangeRef`: which change on which host. A discriminated union, so code that only works on one
 * host has to say so (and the type checker finds every place that must learn a new host).
 */
import { z } from "zod";

export const HOST_KINDS = ["artifacts", "github"] as const;
export const HostKind = z.enum(HOST_KINDS);
export type HostKind = z.infer<typeof HostKind>;

/** A Change on the native host: the platform's own repo row and Change row. */
export const ArtifactsChangeRef = z.object({
  host: z.literal("artifacts"),
  repoId: z.string().min(1).max(64),
  changeId: z.string().min(1).max(64),
});
export type ArtifactsChangeRef = z.infer<typeof ArtifactsChangeRef>;

/** A pull request on GitHub (`owner/repo#number`). */
export const GithubChangeRef = z.object({
  host: z.literal("github"),
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  number: z.number().int().positive(),
});
export type GithubChangeRef = z.infer<typeof GithubChangeRef>;

export const ChangeRef = z.discriminatedUnion("host", [ArtifactsChangeRef, GithubChangeRef]);
export type ChangeRef = z.infer<typeof ChangeRef>;

/** A repository on a host (`main.advanced`, `queue.group_created`, reverts). */
export const RepoRef = z.discriminatedUnion("host", [
  z.object({ host: z.literal("artifacts"), repoId: z.string().min(1).max(64) }),
  z.object({
    host: z.literal("github"),
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
  }),
]);
export type RepoRef = z.infer<typeof RepoRef>;

/** Stable string key: `artifacts:<repoId>/<changeId>` or `github:<owner>/<repo>#<number>`. */
export function changeRefKey(ref: ChangeRef): string {
  switch (ref.host) {
    case "artifacts":
      return `artifacts:${ref.repoId}/${ref.changeId}`;
    case "github":
      return `github:${ref.owner}/${ref.repo}#${ref.number}`;
  }
}

/** Inverse of `changeRefKey`; also accepts the bare GitHub form `owner/repo#123`. */
export function parseChangeRef(key: string): ChangeRef | null {
  const native = /^artifacts:([^/\s]+)\/([^/\s]+)$/.exec(key);
  if (native !== null) {
    const parsed = ArtifactsChangeRef.safeParse({
      host: "artifacts",
      repoId: native[1],
      changeId: native[2],
    });
    return parsed.success ? parsed.data : null;
  }
  const gh = /^(?:github:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(key);
  if (gh !== null) {
    const parsed = GithubChangeRef.safeParse({
      host: "github",
      owner: gh[1],
      repo: gh[2],
      number: Number(gh[3]),
    });
    return parsed.success ? parsed.data : null;
  }
  return null;
}

export function repoOf(ref: ChangeRef): RepoRef {
  return ref.host === "artifacts"
    ? { host: "artifacts", repoId: ref.repoId }
    : { host: "github", owner: ref.owner, repo: ref.repo };
}

export function sameChange(a: ChangeRef, b: ChangeRef): boolean {
  return changeRefKey(a) === changeRefKey(b);
}
