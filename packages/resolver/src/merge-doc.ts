/**
 * The runner's merge documents (`gittifacts-runner merge-attempt` / `apply-resolution`), validated.
 * They come from a sandbox that ran repository-controlled git state, so they are external input.
 */
import { Sha } from "@app/evidence";
import { z } from "zod";

export const MERGE_PREFIX = "::merge::";

export const ConflictKind = z.enum(["content", "add-add", "modify-delete", "other"]);
export type ConflictKind = z.infer<typeof ConflictKind>;

export const MergeMarkers = z.object({
  size: z.number().int().min(7).max(64),
  ours: z.string().min(1).max(100),
  base: z.string().min(1).max(100),
  theirs: z.string().min(1).max(100),
});
export type MergeMarkers = z.infer<typeof MergeMarkers>;

export const ConflictFileDoc = z.object({
  path: z.string().min(1).max(4096),
  kind: ConflictKind,
  mode: z.string().regex(/^[0-7]{6}$/),
  binary: z.boolean(),
  tooLarge: z.boolean(),
  base: z.string().nullable(),
  /** The upstream side (`--onto`). */
  ours: z.string().nullable(),
  /** The Change's side (`--head`). */
  theirs: z.string().nullable(),
  merged_with_markers: z.string().nullable(),
});
export type ConflictFileDoc = z.infer<typeof ConflictFileDoc>;

const UpstreamCommitDoc = z.object({ sha: Sha, subject: z.string().max(1000) });

export const MergeAttempt = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("clean"),
    base: Sha,
    onto: Sha,
    head: Sha,
    newSha: Sha,
    files: z.array(ConflictFileDoc).max(0),
    markers: MergeMarkers,
    upstreamCommits: z.array(UpstreamCommitDoc).max(200).default([]),
    messages: z.array(z.string()).max(500).default([]),
  }),
  z.object({
    status: z.literal("conflict"),
    base: Sha,
    onto: Sha,
    head: Sha,
    conflictSha: Sha,
    files: z.array(ConflictFileDoc).min(1).max(500),
    markers: MergeMarkers,
    upstreamCommits: z.array(UpstreamCommitDoc).max(200).default([]),
    messages: z.array(z.string()).max(500).default([]),
  }),
  z.object({
    status: z.literal("error"),
    base: Sha.nullable(),
    onto: Sha.nullable(),
    head: Sha.nullable(),
    note: z.string().max(10_000),
    files: z.array(z.unknown()).max(0),
  }),
]);
export type MergeAttempt = z.infer<typeof MergeAttempt>;

export const ApplyResolutionDoc = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("resolved"),
    parentSha: Sha,
    newSha: Sha,
    files: z.array(z.string()),
  }),
  z.object({
    status: z.literal("error"),
    parentSha: Sha.nullable(),
    note: z.string().max(10_000),
    files: z.array(z.string()),
  }),
]);
export type ApplyResolutionDoc = z.infer<typeof ApplyResolutionDoc>;

/** The last `::merge::` line of a runner's stdout, parsed with `schema`; throws when absent/invalid. */
export function parseMergeOutput<T extends z.ZodType>(stdout: string, schema: T): z.infer<T> {
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(MERGE_PREFIX));
  if (line === undefined) throw new Error(`no ${MERGE_PREFIX} line in the runner output`);
  return schema.parse(JSON.parse(line.slice(MERGE_PREFIX.length)));
}
