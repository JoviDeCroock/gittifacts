/**
 * An in-memory stand-in for the platform's read API (what the checkers use), its /start, a
 * credential-less POST /api/v1/projects, and preview hosts. Shapes follow apps/platform's
 * OpenAPI schemas (only the fields the eval reads, plus a few extras to prove passthrough).
 */

export const ADMIN_TOKEN = "gtf_eval_admin";
export const HOST = "https://platform.test";
export const SUFFIX = "-pv.resynapse.dev";

type Kind = "human" | "agent" | "system";

export interface FakeRepo {
  id: string;
  name: string;
  importedFrom: string | null;
  template: string | null;
  createdAt: string;
  claim: { status: "claimed" | "unclaimed"; ownerId: string | null; expiresAt: string | null };
}

export interface FakeChange {
  id: string;
  repoId: string;
  planId: string | null;
  authorId: string;
  authorKind: Kind;
  status: string;
  lane: 0 | 1 | 2 | null;
  headSha: string | null;
  tourId: string | null;
  createdAt: string;
}

export interface FakeEvent {
  seq: number;
  at: string;
  principalId: string;
  action: string;
  subject: string;
}

const SHA = "a".repeat(40);

export class FakePlatform {
  repos = new Map<string, FakeRepo>();
  changes = new Map<string, FakeChange>();
  evidence = new Map<string, { items: Record<string, unknown>[]; signedAt: string; ok: boolean }>();
  tours = new Map<string, { stops: number; stale: boolean }>();
  plans = new Map<string, string[]>();
  audit: FakeEvent[] = [];
  principals: Record<string, { id: string; name: string; kind: Kind; ownerId: string | null }> = {
    system: { id: "system", name: "system", kind: "system", ownerId: null },
    human1: { id: "human1", name: "Ada", kind: "human", ownerId: null },
  };
  /** Change ids whose latest-head preview serves the current time. */
  green = new Set<string>();
  anonymousAvailable = true;
  /** Previews of new projects go green at once (CI and preview "finish" instantly). */
  autoGreen = false;
  /** Called after a credential-less project is created. */
  onCreate: ((repoId: string) => void) | null = null;
  requests: { method: string; url: string; auth: string | null; evalRun: string | null }[] = [];
  private n = 0;

  addRepo(p: Partial<FakeRepo> & { id: string }): FakeRepo {
    const r: FakeRepo = {
      name: p.id,
      importedFrom: null,
      template: "workers-api",
      createdAt: new Date().toISOString(),
      claim: { status: "unclaimed", ownerId: null, expiresAt: null },
      ...p,
    };
    this.repos.set(r.id, r);
    return r;
  }

  addChange(p: Partial<FakeChange> & { id: string; repoId: string }): FakeChange {
    const c: FakeChange = {
      planId: null,
      authorId: "agent1",
      authorKind: "agent",
      status: "running",
      lane: null,
      headSha: SHA,
      tourId: null,
      createdAt: new Date().toISOString(),
      ...p,
    };
    this.changes.set(c.id, c);
    return c;
  }

  addEvidence(
    changeId: string,
    items: Record<string, unknown>[],
    ok = true,
    signedAt = new Date().toISOString(),
  ) {
    this.evidence.set(changeId, { items, signedAt, ok });
  }

  event(e: Omit<FakeEvent, "seq" | "at"> & { at?: string }): void {
    this.audit.push({ seq: this.audit.length + 1, at: e.at ?? new Date().toISOString(), ...e });
  }

  /** What credential-less create_project does: an unclaimed repo + its bootstrap Change. */
  createProject(body: { name?: string; template?: string; from?: string }) {
    const id = `r${(++this.n).toString().padStart(5, "0")}x`;
    this.addRepo({
      id,
      name: body.name ?? id,
      template: body.template ?? null,
      importedFrom: body.from ?? null,
    });
    const bs = `bs-${id}`;
    this.addChange({
      id: bs,
      repoId: id,
      authorId: "system",
      authorKind: "system",
      status: "released",
    });
    if (this.autoGreen) this.green.add(bs);
    this.addEvidence(bs, [
      {
        id: "preview",
        kind: "preview",
        status: "ok",
        url: `https://p-${bs}-${SHA.slice(0, 8)}${SUFFIX}`,
      },
    ]);
    this.principals[`anon-${id}`] = {
      id: `anon-${id}`,
      name: "unclaimed agent",
      kind: "agent",
      ownerId: null,
    };
    this.event({
      principalId: `anon-${id}`,
      action: "project.unclaimed-created",
      subject: `repo:${id}`,
    });
    this.onCreate?.(id);
    return {
      projectId: id,
      remote: {
        url: `https://acct.artifacts.cloudflare.net/git/ns/task-${id}0000.git`,
        token: "push",
        branch: "main",
      },
      token: `gtf_unclaimed_${id}`,
      mcpUrl: `${HOST}/mcp`,
      previewUrl: `https://p-${bs}${SUFFIX}`,
      claimUrl: `${HOST}/claim/xyz`,
      nextSteps: [
        { title: "Wait", call: `wait_for_change({ changeId: "${bs}", until: "evidence_ready" })` },
      ],
    };
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = () =>
  json({ error: { code: "not-found", message: "nope", fix: { explanation: "x" } } }, 404);

export function fakePlatformFetch(p: FakePlatform) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    p.requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.get("authorization"),
      evalRun: req.headers.get("x-gittifacts-eval-run"),
    });
    if (url.hostname.endsWith(SUFFIX)) {
      const label = url.hostname.slice(0, -SUFFIX.length).replace(/^p-/, "");
      const changeId = [...p.changes.keys()].find(
        (id) => label === id || label.startsWith(`${id}-`),
      );
      if (changeId && p.green.has(changeId)) return json({ now: new Date().toISOString() });
      return new Response("Starting preview…", { status: 503, headers: { "retry-after": "5" } });
    }
    if (url.origin !== HOST) return new Response("no route", { status: 502 });
    if (url.pathname === "/start") {
      return json({
        kind: "gittifacts.start",
        auth: { anonymous: { available: p.anonymousAvailable } },
      });
    }
    if (url.pathname === "/api/v1/projects" && req.method === "POST") {
      if (!p.anonymousAvailable)
        return json({ error: { code: "creation-disabled", message: "off" } }, 503);
      return json(p.createProject((await req.json()) as { name?: string }), 201);
    }
    if (req.headers.get("authorization") !== `Bearer ${ADMIN_TOKEN}`) {
      return json({ error: { code: "unauthorized", message: "authentication required" } }, 401);
    }
    const seg = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    // /api/v1/<kind>/<id>/<sub>
    const [, , kind, id, sub] = seg;
    if (kind === "repos" && id) {
      const repo = p.repos.get(id);
      if (!repo) return notFound();
      if (sub === undefined) return json({ repo, shadow: {}, counts: {} });
      if (sub === "changes") {
        const changes = [...p.changes.values()].filter((c) => c.repoId === id);
        return json({
          changes: changes.map((c) => ({ ...c, planTitle: null, authorName: "x" })),
          principals: {},
        });
      }
      if (sub === "plans")
        return json({ plans: (p.plans.get(id) ?? []).map((pid) => ({ id: pid })) });
    }
    if (kind === "changes" && id) {
      const change = p.changes.get(id);
      if (!change) return notFound();
      const { authorKind: _k, ...rest } = change;
      if (sub === undefined)
        return json({ change: rest, plan: null, runs: [], classification: null, principals: {} });
      if (sub === "evidence") {
        const ev = p.evidence.get(id);
        if (!ev) return notFound();
        return json({
          evidence: {
            id: `ev-${id}`,
            changeId: id,
            headSha: SHA,
            baseSha: SHA,
            items: ev.items,
            createdAt: ev.signedAt,
            notesWritten: true,
            attestation: { signedAt: ev.signedAt, v: 1 },
          },
          verification: { ok: ev.ok },
        });
      }
      if (sub === "tour") {
        const t = p.tours.get(id);
        if (!t) return notFound();
        return json({
          tour: { id: `tour-${id}`, stops: Array.from({ length: t.stops }, () => ({})) },
          stale: t.stale,
        });
      }
    }
    if (kind === "audit") {
      const subject = url.searchParams.get("subject");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const before = url.searchParams.get("cursor");
      let events = [...p.audit].reverse();
      if (subject) events = events.filter((e) => e.subject === subject);
      if (before) events = events.filter((e) => e.seq < Number(before));
      const page = events.slice(0, limit);
      const nextCursor = events.length > limit ? String(page.at(-1)!.seq) : null;
      const principals = Object.fromEntries(
        page
          .filter((e) => p.principals[e.principalId])
          .map((e) => [e.principalId, p.principals[e.principalId]]),
      );
      return json({
        events: page.map((e) => ({ ...e, summary: e.action })),
        nextCursor,
        chain: { verified: true },
        principals,
      });
    }
    return notFound();
  };
}
