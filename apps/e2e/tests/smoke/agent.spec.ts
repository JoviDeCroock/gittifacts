/**
 * Post-deploy, the agent path end to end on the live platform: an anonymous create_project from a
 * template (no account, like an agent told only "use <host>"), then wait_for_change over MCP on
 * the bootstrap Change until its first green check, then the preview serves. Real Artifacts,
 * containers, Workflows and previews. Asserted under a time budget (SMOKE_TTFG_BUDGET_S, 120 s).
 *
 * Cleanup: the project is unclaimed, so the expiry cron deletes it after UNCLAIMED_TTL_DAYS; its
 * name starts with "smoke-" so it is easy to tell apart until then.
 */
import { createPlatformClient } from "@app/mcp/client";
import { expect, test } from "../../lib/fixtures.js";
import { pollUntil, uniqueName } from "../../lib/poll.js";

const BUDGET_MS = Number(process.env.SMOKE_TTFG_BUDGET_S ?? 120) * 1000;
const TEMPLATE = process.env.SMOKE_TEMPLATE ?? "workers-api";

interface Created {
  projectId: string;
  token: string | null;
  mcpUrl: string;
  previewUrl: string | null;
  claimUrl: string | null;
  bootstrapChangeId: string | null;
}

test("anonymous create_project → first green check and a serving preview, within budget", async ({ request, baseURL }) => {
  const t0 = Date.now();
  const res = await request.post(`${baseURL}/api/v1/projects`, {
    headers: { "content-type": "application/json", origin: baseURL as string },
    data: { template: TEMPLATE, name: uniqueName(`smoke-${(process.env.SMOKE_EXPECT_COMMIT ?? "local").slice(0, 7)}`).toLowerCase() },
  });
  if (res.status() === 503) {
    const body = (await res.json()) as { error?: { code?: string } };
    // The operator's kill switch is a decision, not a regression: reported, never green.
    test.skip(body.error?.code === "creation-disabled", "unclaimed creation is switched off (kill switch)");
  }
  expect(res.status(), await res.text()).toBe(201);
  const created = (await res.json()) as Created;
  expect(created.token).toBeTruthy();
  expect(created.bootstrapChangeId).toBeTruthy();
  expect(created.claimUrl).toMatch(/\/claim\//);
  const changeId = created.bootstrapChangeId as string;

  const mcp = await createPlatformClient(created.mcpUrl, created.token as string);
  try {
    // wait_for_change long-polls ≤ 50 s per call; call again while it says "timeout".
    const waited = await pollUntil(
      async () => {
        const left = Math.max(5, Math.min(50, Math.floor((t0 + BUDGET_MS - Date.now()) / 1000)));
        const r = await mcp.tools.wait_for_change({ changeId, until: "evidence_ready", timeoutSec: left });
        if (r.isError) throw new Error(JSON.stringify(r.content));
        return r.structuredContent;
      },
      (w) => w.reached === true || (w.reason !== "timeout" && w.reason !== undefined),
      { timeoutMs: BUDGET_MS, what: "the bootstrap Change's evidence", minIntervalMs: 100, maxIntervalMs: 1_000 },
    );
    expect(waited, JSON.stringify(waited).slice(0, 500)).toMatchObject({ reached: true });

    const status = await mcp.tools.get_change_status({ changeId });
    if (status.isError) throw new Error(JSON.stringify(status.content));
    const runs = status.structuredContent.runs;
    expect(runs.some((r) => r.status === "passed"), JSON.stringify(runs).slice(0, 500)).toBe(true);
  } finally {
    await mcp.client.close();
  }

  // The preview serves the app once the first run is green (it shows a "building" page before).
  if (created.previewUrl !== null) {
    const previewUrl = created.previewUrl.replace(/\/+$/, "");
    await pollUntil(
      async () => (await request.get(`${previewUrl}/health`, { timeout: 30_000 })).status(),
      (s) => s === 200,
      { timeoutMs: Math.max(10_000, t0 + BUDGET_MS - Date.now()), what: "the preview's /health to answer 200" },
    );
  }
  const elapsed = Date.now() - t0;
  test.info().annotations.push({ type: "ttfg", description: `${Math.round(elapsed / 1000)} s (budget ${BUDGET_MS / 1000} s)` });
  expect(elapsed, "time to first green").toBeLessThanOrEqual(BUDGET_MS);
});
