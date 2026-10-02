/**
 * The checkers' read-only view of the platform API, with the eval-admin credential
 * (`EVAL_ADMIN_TOKEN`: an agent token with `repo:read` on all repos, owned by a dedicated human).
 * That token is never given to an agent. Schemas are the minimal subsets the checks read; extra
 * fields are ignored so platform additions never break the eval.
 */
import { z } from "zod";
import type { FetchLike } from "../tools/probe.js";

const Claim = z.object({ status: z.enum(["claimed", "unclaimed"]) }).passthrough();

export const ApiRepo = z
  .object({
    id: z.string(),
    name: z.string(),
    importedFrom: z.string().nullable().optional(),
    template: z.string().nullable().optional(),
    createdAt: z.string(),
    claim: Claim,
  })
  .passthrough();
export type ApiRepo = z.infer<typeof ApiRepo>;

export const ApiChange = z
  .object({
    id: z.string(),
    repoId: z.string(),
    planId: z.string().nullable(),
    authorId: z.string(),
    status: z.string(),
    lane: z.number().int().nullable(),
    headSha: z.string().nullable(),
    tourId: z.string().nullable().optional(),
    createdAt: z.string(),
  })
  .passthrough();
export type ApiChange = z.infer<typeof ApiChange>;

const PrincipalRef = z
  .object({ id: z.string(), kind: z.enum(["human", "agent", "system"]) })
  .passthrough();
const Principals = z.record(z.string(), PrincipalRef);

const ChangeSummary = ApiChange.extend({
  authorKind: z.enum(["human", "agent", "system"]).optional(),
});

export const EvidenceItem = z
  .object({ id: z.string(), kind: z.string(), status: z.string() })
  .passthrough();
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const ApiEvidence = z.object({
  evidence: z
    .object({
      headSha: z.string(),
      items: z.array(EvidenceItem),
      createdAt: z.string().optional(),
      attestation: z.object({ signedAt: z.string() }).passthrough().optional(),
    })
    .passthrough(),
  verification: z.object({ ok: z.boolean() }).passthrough(),
});
export type ApiEvidence = z.infer<typeof ApiEvidence>;

export const ApiTour = z.object({
  tour: z.object({ id: z.string(), stops: z.array(z.unknown()) }).passthrough(),
  stale: z.boolean().optional(),
});

export const AuditEvent = z
  .object({
    seq: z.number().int(),
    at: z.string(),
    principalId: z.string(),
    action: z.string(),
    subject: z.string(),
    summary: z.string().optional(),
  })
  .passthrough();
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditPage = z.object({
  events: z.array(AuditEvent),
  nextCursor: z.string().nullable(),
  principals: Principals,
});
export type AuditPage = z.infer<typeof AuditPage>;

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

export class PlatformApi {
  constructor(
    private readonly host: string,
    private readonly token: string,
    private readonly fetcher: FetchLike,
  ) {}

  /** GET → parsed JSON; null on 404; throws ApiError otherwise. */
  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
    const res = await this.fetcher(`${this.host.replace(/\/+$/, "")}${path}`, {
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
    });
    if (res.status === 404) return null;
    const text = await res.text();
    if (!res.ok)
      throw new ApiError(res.status, path, `GET ${path} → ${res.status}: ${text.slice(0, 300)}`);
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new ApiError(
        res.status,
        path,
        `GET ${path}: unexpected body (${parsed.error.issues[0]?.message})`,
      );
    }
    return parsed.data;
  }

  async repo(id: string): Promise<ApiRepo | null> {
    const r = await this.get(
      `/api/v1/repos/${encodeURIComponent(id)}`,
      z.object({ repo: ApiRepo }),
    );
    return r?.repo ?? null;
  }

  async changes(repoId: string) {
    const r = await this.get(
      `/api/v1/repos/${encodeURIComponent(repoId)}/changes`,
      z.object({ changes: z.array(ChangeSummary), principals: Principals.optional() }),
    );
    return r?.changes ?? [];
  }

  async change(id: string) {
    return this.get(
      `/api/v1/changes/${encodeURIComponent(id)}`,
      z.object({ change: ApiChange, principals: Principals.optional() }).passthrough(),
    );
  }

  async evidence(changeId: string): Promise<ApiEvidence | null> {
    return this.get(`/api/v1/changes/${encodeURIComponent(changeId)}/evidence`, ApiEvidence);
  }

  async tour(changeId: string) {
    return this.get(`/api/v1/changes/${encodeURIComponent(changeId)}/tour`, ApiTour);
  }

  async plans(repoId: string) {
    const r = await this.get(
      `/api/v1/repos/${encodeURIComponent(repoId)}/plans`,
      z.object({ plans: z.array(z.object({ id: z.string() }).passthrough()) }),
    );
    return r?.plans ?? [];
  }

  async audit(q: { subject?: string; cursor?: string; limit?: number }): Promise<AuditPage> {
    const p = new URLSearchParams({ limit: String(q.limit ?? 200) });
    if (q.subject) p.set("subject", q.subject);
    if (q.cursor) p.set("cursor", q.cursor);
    const page = await this.get(`/api/v1/audit?${p}`, AuditPage);
    return page ?? { events: [], nextCursor: null, principals: {} };
  }
}
