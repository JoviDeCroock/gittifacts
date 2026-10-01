/**
 * Artifacts push events (`cf.artifacts.repo.pushed`, docs/research/artifacts.md §6) delivered by
 * `triggers.events` as the PushRouter workflow's payload. Validated leniently: unknown fields are
 * ignored and both `repoName` / `repo_name` spellings are accepted.
 */
import { z } from "zod";

export const PUSH_EVENT_TYPE = "cf.artifacts.repo.pushed";

const ShaLike = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

export const ArtifactsPushEvent = z
  .object({
    type: z.string(),
    source: z
      .object({
        type: z.string().optional(),
        namespace: z.string().optional(),
        repoName: z.string().optional(),
        repo_name: z.string().optional(),
      })
      .passthrough(),
    payload: z
      .object({
        ref: z.string().min(1),
        before: ShaLike,
        after: ShaLike,
      })
      .passthrough(),
  })
  .passthrough();
export type ArtifactsPushEvent = z.infer<typeof ArtifactsPushEvent>;

export type ParsedPush =
  | {
      ok: true;
      namespace: string | null;
      repoName: string;
      ref: string;
      before: string;
      after: string;
    }
  | { ok: false; reason: string };

export function parsePushEvent(raw: unknown, expectedNamespace?: string): ParsedPush {
  const parsed = ArtifactsPushEvent.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `not an Artifacts push event: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    };
  }
  const e = parsed.data;
  if (e.type !== PUSH_EVENT_TYPE) return { ok: false, reason: `ignoring event type ${e.type}` };
  const repoName = e.source.repoName ?? e.source.repo_name;
  if (repoName === undefined || repoName === "")
    return { ok: false, reason: "event has no repo name" };
  const namespace = e.source.namespace ?? null;
  if (expectedNamespace !== undefined && namespace !== null && namespace !== expectedNamespace) {
    return { ok: false, reason: `event is for namespace ${namespace}` };
  }
  return {
    ok: true,
    namespace,
    repoName,
    ref: e.payload.ref,
    before: e.payload.before,
    after: e.payload.after,
  };
}
