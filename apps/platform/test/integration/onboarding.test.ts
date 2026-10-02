/**
 * O1 acceptance, locally: `create_project({ template })` over MCP → initial commit (template +
 * conventions files) → bootstrap Change → CI (reported like CiRunWorkflow) → preview (PreviewHost
 * DO, fake container) → `wait_for_change(evidence_ready)` → the preview URL served through the
 * gateway with its banner → time-to-first-green recorded.
 *
 * Real: the Hono app and MCP server, auth, D1, the coordinator facade, ChangeCoordinator DO,
 * ChangeWorkflow, PlatformPreviews, the PreviewHost DO and the preview gateway. Fake: Artifacts,
 * the CI containers and the preview container (./fakes.ts, ./preview-fakes.ts), Browser Run.
 */
import {
  createExecutionContext,
  introspectWorkflow,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  AGENTS_MD_MAX_LINES,
  agentsMd,
  defaultCiTs,
  defaultPolicyTs,
  parseCall,
  projectSlug,
  TEMPLATE_IDS,
  TEMPLATES,
  type TemplateId,
} from "@app/conventions";
import {
  bootstrapChangeIdFor,
  changeWorkflowId,
  ciRunIdFor,
  cloudflareBindings,
  createCoordinator,
} from "@app/coordinator";
import { createPlatformClient, type PlatformClient } from "@app/mcp/client";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { facadeOptions } from "../../src/coordinator.js";
import { projectOnboarding } from "../../src/db/schema.js";
import { BANNER_TAG } from "../../src/previews/pages.js";
import { buildPorts } from "../../src/runtime/ports.js";
import { store } from "../fixtures.js";
import { call, createAgent, json, ORIGIN, signUpHuman, type TestApp } from "../http.js";
import { type IntegrationFakes, integrationOverrides, resetIntegrationFakes } from "./fakes.js";
import { resetPreviewFakes } from "./preview-fakes.js";
import { request } from "./unclaimed-helpers.js";

function fetchVia(app: TestApp) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(input, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

function platformApp(): TestApp {
  return createApp({
    coordinator: (e, _ctx, origin) =>
      createCoordinator(
        buildPorts(e, "default", { overrides: integrationOverrides("default", e) }),
        cloudflareBindings(e),
        facadeOptions(origin),
      ),
  });
}

async function until<T>(
  what: string,
  fn: () => T | undefined | Promise<T | undefined>,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

let fakes: IntegrationFakes;

beforeEach(() => {
  fakes = resetIntegrationFakes();
  resetPreviewFakes();
});

describe("create_project → first green (workerd, fake Artifacts/containers)", () => {
  it.each(TEMPLATE_IDS)(
    "%s: initial commit, bootstrap CI, preview with banner, ttfg",
    async (template: TemplateId) => {
      const app = platformApp();
      const human = await signUpHuman(app);
      const agent = await createAgent(app, human.cookie);
      const mcp: PlatformClient = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, {
        fetch: fetchVia(app),
      });
      await using workflows = await introspectWorkflow(env.CHANGE_WORKFLOW);
      await workflows.modifyAll(async (m) => {
        await m.disableSleeps();
        await m.disableRetryDelays();
      });
      try {
        const t0 = Date.now();
        const created = await mcp.tools.create_project({ template, name: `My ${template}` });
        if (created.isError) throw new Error(JSON.stringify(created.content));
        const respondedMs = Date.now() - t0;
        const p = created.structuredContent;
        const name = projectSlug(`My ${template}`);
        expect(p).toMatchObject({
          name,
          template,
          defaultBranch: "main",
          token: null,
          claimUrl: null,
          mcpUrl: `${ORIGIN}/mcp`,
          bootstrapChangeId: bootstrapChangeIdFor(p.projectId),
        });

        // 1. The initial commit: the template rendered, plus the conventions' generated files.
        const head = fakes.git.head(name);
        expect(head).not.toBeNull();
        const files = fakes.git.filesAt(head as string);
        const spec = TEMPLATES[template];
        expect(files[".platform/ci.ts"]).toBe(
          defaultCiTs(
            spec.features,
            undefined,
            spec.deployable ? { bundle: spec.manifest.buildOutput } : {},
          ).text,
        );
        expect(files[".platform/policy.ts"]).toBe(
          defaultPolicyTs({ previewRoutes: spec.previewRoutes }).text,
        );
        const agentsText = files["AGENTS.md"] ?? "";
        expect(agentsText).toBe(
          agentsMd({
            projectName: name,
            host: ORIGIN,
            mcpUrl: `${ORIGIN}/mcp`,
            repoId: p.projectId,
            claimed: true,
            template,
          }),
        );
        expect(agentsText.split("\n").length).toBeLessThan(AGENTS_MD_MAX_LINES);
        expect(files["pnpm-lock.yaml"]?.length).toBeGreaterThan(1000);
        expect(
          Object.keys(files).some((f) => f.startsWith("node_modules/") || f.startsWith("dist/")),
        ).toBe(false);
        for (const [path, text] of Object.entries(files)) {
          expect(text, path).not.toMatch(/\{\{(projectName|host|mcpUrl|repoId)\}\}/);
        }
        if (files["wrangler.jsonc"] !== undefined) {
          expect(files["wrangler.jsonc"]).toContain(`"name": "${name}"`);
        }

        // 2. The first Change's fork, ready to push to.
        expect(p.remote).toMatchObject({ branch: "main", url: expect.stringContaining("task-") });
        expect(fakes.git.tokens.at(-1)).toMatchObject({
          scope: "write",
          repo: `task-${p.remote?.changeId}`,
        });
        expect(fakes.git.head(`task-${p.remote?.changeId}`)).toBe(head);

        // 3. nextSteps are valid tool calls (or shell commands), first: wait for the bootstrap.
        const tools = new Set((await mcp.listTools()).map((t) => t.name));
        for (const step of p.nextSteps) {
          if (step.call !== undefined) {
            const parsed = parseCall(step.call);
            expect(parsed, step.call).not.toBeNull();
            expect(tools.has(parsed?.tool ?? ""), step.call).toBe(true);
          } else {
            expect(step.command, step.title).toBeDefined();
          }
        }
        expect(parseCall(p.nextSteps[0]?.call ?? "")).toEqual({
          tool: "wait_for_change",
          args: { changeId: p.bootstrapChangeId, until: "evidence_ready", timeoutSec: 50 },
        });

        // 4. The preview URL exists before the preview does: "Building…" while CI runs.
        const hasPreview = spec.manifest.previewCommand !== null;
        if (hasPreview) {
          expect(p.previewUrl).toBe(`https://p-${p.bootstrapChangeId}-pv.resynapse.dev`);
          const building = await SELF.fetch(p.previewUrl as string, {
            headers: { accept: "text/html" },
          });
          expect(building.status).toBe(503);
          expect(building.headers.get("retry-after")).toBe("5");
          expect(await building.text()).toContain("Building");
        } else {
          expect(p.previewUrl).toBeNull();
        }

        // 5. CI runs on the initial commit (no evidence steps, the main repo, no fork) and is green.
        const bootstrapId = p.bootstrapChangeId as string;
        const runId = ciRunIdFor(changeWorkflowId(bootstrapId, head as string));
        const run = await until("the bootstrap CI run", () => fakes.ci.runs.get(runId));
        expect(run.request).toMatchObject({
          artifactsRepo: name,
          headSha: head,
          baseSha: head,
          evidenceSteps: [],
          network: "open",
        });
        const waiting = mcp.tools.wait_for_change({
          changeId: bootstrapId,
          until: "evidence_ready",
          timeoutSec: 60,
        });
        expect(await fakes.ci.finish(env, runId)).toMatchObject({
          accepted: true,
          forwarded: true,
        });
        const waited = await waiting;
        if (waited.isError) throw new Error(JSON.stringify(waited.content));
        const greenMs = Date.now() - t0;
        expect(waited.structuredContent).toMatchObject({ reached: true, reason: "reached" });

        // 6. Evidence: the preview item (pinned URL) and screenshots of the template's routes.
        const evidence = await mcp.tools.get_evidence({ changeId: bootstrapId });
        if (evidence.isError) throw new Error(JSON.stringify(evidence.content));
        const items = evidence.structuredContent.items as Array<{
          kind: string;
          status: string;
          url?: string;
        }>;
        const preview = items.find((i) => i.kind === "preview");
        if (hasPreview) {
          expect(preview).toMatchObject({ status: "ok", url: p.previewUrl });
        } else {
          expect(preview?.status).toBe("skipped");
        }

        if (hasPreview) {
          // 7. The preview through the gateway: banner, no Domain cookies, noindex, no framing.
          const page = await SELF.fetch(p.previewUrl as string, {
            headers: { accept: "text/html" },
          });
          expect(page.status).toBe(200);
          const html = await page.text();
          expect(html).toContain(`<${BANNER_TAG}`);
          expect(html).toContain(
            `Not production · preview of ${name} · change ${bootstrapId} · gittifacts`,
          );
          expect(html.indexOf(`<${BANNER_TAG}`)).toBeLessThan(html.indexOf("Hello from /"));
          expect(page.headers.get("x-robots-tag")).toContain("noindex");
          expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
          expect(page.headers.getSetCookie()).toEqual(["session=1; Path=/; HttpOnly"]);
          // The pinned URL serves the same head.
          const pinned = await SELF.fetch(
            `https://p-${bootstrapId}-${(head as string).slice(0, 8)}-pv.resynapse.dev/about/`,
            { headers: { accept: "text/html" } },
          );
          expect(await pinned.text()).toContain("Hello from /about/");
          // wrangler dev's local explorer is never reachable.
          const blocked = await SELF.fetch(`${p.previewUrl}/cdn-cgi/local/explorer/api`);
          expect(blocked.status).toBe(404);
          // Non-HTML responses pass through untouched.
          const health = await SELF.fetch(`${p.previewUrl}/health`);
          expect(await health.json()).toEqual({ ok: true });

          const shots = items.find((i) => i.kind === "screenshots") as
            | { status: string; shots: Array<{ route: string; afterRef: string }> }
            | undefined;
          await until("screenshots", async () => {
            const ev = await mcp.tools.get_evidence({ changeId: bootstrapId });
            const s = ev.isError
              ? undefined
              : (ev.structuredContent.items as Array<{ kind: string; status: string }>).find(
                  (i) => i.kind === "screenshots" && i.status === "ok",
                );
            return s;
          });
          expect(shots === undefined || ["ok", "skipped"].includes(shots.status)).toBe(true);
        }

        // 8. Released, never classified; the TTFG row says green.
        const done = await until("the bootstrap to be released", async () => {
          const s = await mcp.tools.get_change_status({ changeId: bootstrapId });
          return !s.isError && s.structuredContent.change.status === "released"
            ? s.structuredContent
            : undefined;
        });
        expect(done.change).toMatchObject({ lane: null, mergedSha: head });
        const row = await until("the ttfg row", async () => {
          const r = await store()
            .db.select()
            .from(projectOnboarding)
            .where(eq(projectOnboarding.projectId, p.projectId))
            .get();
          return r?.outcome != null ? r : undefined;
        });
        expect(row).toMatchObject({
          template,
          source: "template",
          outcome: hasPreview ? "green" : "no-preview",
          ciStatus: "passed",
        });
        expect(row.msToGreen).not.toBeNull();
        console.log(
          `[ttfg/fakes] ${template}: create_project responded in ${respondedMs} ms, evidence_ready (CI green${hasPreview ? " + preview serving" : ""}) after ${greenMs} ms`,
        );
      } finally {
        await mcp.client.close();
      }
    },
  );

  it("the dashboard reads time-to-first-green from D1 without an API token (platform admins)", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    // Every project's id and timings: platform admins (and auditors) only.
    const admins = { PLATFORM_ADMINS: human.principal.id };
    const res = await request(app, "GET", "/internal/ttfg?days=7", {
      cookie: human.cookie,
      env: admins,
    });
    expect(res.status).toBe(200);
    const report = await json<{ source: string; targetMs: number; note: string }>(res);
    expect(report).toMatchObject({ source: "d1", targetMs: 60_000 });
    const notAdmin = await call(app, "GET", "/internal/ttfg", { cookie: human.cookie });
    expect(notAdmin.status).toBe(403);
    const agent = await createAgent(app, human.cookie);
    const denied = await request(app, "GET", "/internal/ttfg", { token: agent.token, env: admins });
    expect(denied.status).toBe(403);
  });

  it("POST /api/v1/projects mirrors the tool; unknown templates and scope gaps say what to do", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const bad = await call(app, "POST", "/api/v1/projects", {
      cookie: human.cookie,
      body: { template: "rails" },
    });
    expect(bad.status).toBe(400);
    const both = await call(app, "POST", "/api/v1/projects", {
      cookie: human.cookie,
      body: { template: "workers-api", from: "https://github.com/o/r" },
    });
    expect(both.status).toBe(400);
    const readOnly = await createAgent(app, human.cookie, ["repo:read"]);
    const denied = await call(app, "POST", "/api/v1/projects", {
      token: readOnly.token,
      body: { template: "workers-api" },
    });
    expect(denied.status).toBe(403);
    expect((await json<{ error: { code: string } }>(denied)).error.code).toBe("insufficient-scope");

    // Empty project: README + AGENTS.md + .platform/*, no bootstrap, no preview.
    const empty = await call(app, "POST", "/api/v1/projects", {
      cookie: human.cookie,
      headers: { "idempotency-key": "empty-1" },
      body: { name: "blank", description: "Nothing yet." },
    });
    expect(empty.status).toBe(201);
    const e = await json<{
      projectId: string;
      bootstrapChangeId: string | null;
      previewUrl: string | null;
    }>(empty);
    expect(e).toMatchObject({ bootstrapChangeId: null, previewUrl: null });
    expect(Object.keys(fakes.git.filesAt(fakes.git.head("blank") as string)).sort()).toEqual([
      ".platform/ci.ts",
      ".platform/policy.ts",
      "AGENTS.md",
      "README.md",
    ]);
    // A retry with the same key is the same project (and a fresh grant).
    const again = await call(app, "POST", "/api/v1/projects", {
      cookie: human.cookie,
      headers: { "idempotency-key": "empty-1" },
      body: { name: "blank", description: "Nothing yet." },
    });
    expect(again.status).toBe(201);
    expect((await json<{ projectId: string }>(again)).projectId).toBe(e.projectId);
  });
});
