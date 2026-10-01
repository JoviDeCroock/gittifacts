/**
 * GET /api/v1/blobs/:ref — raw bytes behind an R2 reference (`logRef`, `beforeRef`, `afterRef`,
 * spilled diffs/evidence), authorized by the repo the reference belongs to.
 *
 * Ownership is derived from the key layout, never from the caller:
 *   ci-logs|ci-runs|ci-evidence/<runId>/…            → run → change → repo  (@app/ci-engine RunKeys)
 *   diffs|evidence|screenshots|previews|changes/<changeId>/… → change → repo
 *   repos/<repoId>/…                                  → repo
 * otherwise the object's customMetadata `repoId` / `changeId`. Unattributable refs are 404.
 * Content is served inert (allowlisted types, nosniff, sandboxed CSP) because it is repo-controlled.
 */
import type { Repo } from "@app/domain";
import type { Caller, Services } from "../app-env.js";
import { ApiError, notFound } from "../errors.js";

const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,511}$/;

const RULES: Array<{ re: RegExp; kind: "run" | "change" | "repo" }> = [
  { re: /^ci-(?:logs|runs|evidence)\/([^/]+)\//, kind: "run" },
  { re: /^(?:diffs|evidence|screenshots|previews|changes)\/([^/]+)\//, kind: "change" },
  { re: /^repos\/([^/]+)\//, kind: "repo" },
];

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  json: "application/json",
  log: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};
const SAFE_TYPES = new Set(Object.values(TYPES).map((t) => t.split(";")[0]));

function blobNotFound(ref: string) {
  return notFound(`blob ${ref}`, {
    explanation:
      "No readable object with that reference. Use a logRef/beforeRef/afterRef exactly as an API response gave it.",
  });
}

async function repoOfChange(svc: Services, changeId: string): Promise<string | null> {
  return (await svc.store.getChange(changeId))?.repoId ?? null;
}

async function owningRepoId(
  svc: Services,
  ref: string,
  meta: Record<string, string> | undefined,
): Promise<string | null> {
  for (const rule of RULES) {
    const id = rule.re.exec(ref)?.[1];
    if (!id) continue;
    if (rule.kind === "repo") return id;
    if (rule.kind === "change") return repoOfChange(svc, id);
    const run = await svc.store.getRun(id);
    return run ? repoOfChange(svc, run.changeId) : null;
  }
  if (meta?.repoId) return meta.repoId;
  if (meta?.changeId) return repoOfChange(svc, meta.changeId);
  return null;
}

/** Single place to tighten per-repo read access (claims, org membership) later. */
function canRead(caller: Caller, _repo: Repo): boolean {
  return caller.principal.scopes.includes("repo:read");
}

function contentTypeOf(ref: string, stored: string | undefined): { type: string; inline: boolean } {
  const base = stored?.split(";")[0]?.trim().toLowerCase();
  if (base && SAFE_TYPES.has(base)) return { type: stored ?? base, inline: true };
  const ext = ref.split(".").pop()?.toLowerCase() ?? "";
  const byExt = TYPES[ext];
  return byExt
    ? { type: byExt, inline: true }
    : { type: "application/octet-stream", inline: false };
}

export async function readBlob(svc: Services, caller: Caller, ref: string): Promise<Response> {
  if (!REF_SHAPE.test(ref) || ref.includes("..") || ref.includes("//")) {
    throw new ApiError(400, "invalid-request", "not a blob reference");
  }
  const head = await svc.env.BLOBS.head(ref);
  if (!head) throw blobNotFound(ref);
  const repoId = await owningRepoId(svc, ref, head.customMetadata);
  const repo = repoId ? await svc.store.getRepo(repoId) : null;
  if (!repo || !canRead(caller, repo)) throw blobNotFound(ref);

  const obj = await svc.env.BLOBS.get(ref);
  if (!obj) throw blobNotFound(ref);
  const { type, inline } = contentTypeOf(ref, obj.httpMetadata?.contentType);
  const file = ref.split("/").pop() ?? "blob";
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": type,
      "content-length": String(obj.size),
      etag: obj.httpEtag,
      "cache-control": "private, max-age=60",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${file.replace(/"/g, "")}"`,
    },
  });
}
