import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { extractIssue, NotificationEnvelope } from "../src/webhooks/workers-issues.js";
import { changeFixture, seedWorld, store } from "./fixtures.js";
import { call, expectError, json, makeApp } from "./http.js";

const SECRET = "test-issues-webhook-secret";

const payload = (data: unknown) => ({
  name: "issues→gittifacts",
  text: "New issue in app: TypeError: Cannot read properties of undefined",
  data,
  ts: 1790870150,
  account_id: "acc",
  policy_id: "pol",
  alert_type: "workers_observability_real_time_issue",
  alert_correlation_id: "corr-1",
  alert_event: "ALERT_STATE_EVENT_START",
});

describe("POST /webhooks/workers-issues", () => {
  it("rejects a missing or wrong cf-webhook-auth secret with 401", async () => {
    const onIssue = vi.fn(async () => {});
    const { app } = makeApp({ onIssue });
    await expectError(
      await call(app, "POST", "/webhooks/workers-issues", { body: payload({}) }),
      401,
      "unauthorized",
    );
    await expectError(
      await call(app, "POST", "/webhooks/workers-issues", {
        body: payload({}),
        headers: { "cf-webhook-auth": `${SECRET}x` },
      }),
      401,
      "unauthorized",
    );
    expect(onIssue).not.toHaveBeenCalled();
  });

  it("stores the issue (raw + extracted), links it to the rolling-out change and forwards it", async () => {
    const onIssue = vi.fn(async () => {});
    const { app } = makeApp({ onIssue });
    const s = store();
    const { repo, agent } = await seedWorld(s);
    const change = changeFixture(repo.id, agent, {
      status: "rolling-out",
      rolloutState: {
        status: "rolling",
        versionId: "ver-abc",
        previousVersionId: "ver-old",
        stages: [],
        watchUntil: null,
        flagKey: null,
        lastCheck: null,
      },
    });
    await s.insertChange(change);
    const body = payload({
      issue: { id: "iss-42", title: "TypeError: x is undefined", count: 5 },
      service: "app",
      scriptVersion: { id: "ver-abc" },
      firstObserved: "2026-10-01T10:00:00Z",
      lastObserved: 1790870150,
    });
    const res = await call(app, "POST", "/webhooks/workers-issues", {
      body,
      headers: { "cf-webhook-auth": SECRET },
    });
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({
      received: true,
      issueId: "iss-42",
      changeId: change.id,
      forwarded: true,
    });
    expect(onIssue).toHaveBeenCalledWith(body);

    const issues = await s.listIssues({ changeId: change.id });
    expect(issues).toEqual([
      {
        id: "iss-42",
        changeId: change.id,
        title: "TypeError: x is undefined",
        count: 5,
        firstSeen: "2026-10-01T10:00:00.000Z",
        lastSeen: new Date(1790870150 * 1000).toISOString(),
        versionId: "ver-abc",
        url: null,
      },
    ]);
    const raw = await env.DB.prepare(
      "SELECT raw, script_name FROM issues WHERE id = 'iss-42'",
    ).first<{
      raw: string;
      script_name: string;
    }>();
    expect(JSON.parse(raw!.raw)).toEqual(body);
    expect(raw!.script_name).toBe("app");
  });

  it("accepts an envelope with unknown data and still stores it when the coordinator is down", async () => {
    const { app } = makeApp(); // unavailable coordinator: onIssue throws upstream
    const res = await call(app, "POST", "/webhooks/workers-issues", {
      body: payload("not an object"),
      headers: { "cf-webhook-auth": SECRET },
    });
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ issueId: "corr-1", changeId: null, forwarded: false });
    await expectError(
      await call(app, "POST", "/webhooks/workers-issues", {
        body: [1, 2],
        headers: { "cf-webhook-auth": SECRET },
      }),
      400,
      "invalid-request",
    );
  });

  it("extracts leniently from several plausible shapes", async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const flat = await extractIssue(
      NotificationEnvelope.parse({
        data: {
          issueId: 7,
          title: "Boom",
          occurrences: "3",
          scriptName: "w",
          versionId: "v1",
          url: "https://x.dev/i/7",
        },
      }),
      now,
    );
    expect(flat).toMatchObject({
      id: "7",
      title: "Boom",
      count: 3,
      scriptName: "w",
      versionId: "v1",
      url: "https://x.dev/i/7",
    });
    const empty = await extractIssue(NotificationEnvelope.parse({ text: "something" }), now);
    expect(empty).toMatchObject({
      title: "something",
      count: 1,
      scriptName: "unknown",
      versionId: null,
    });
    expect(empty.id).toMatch(/^anon-/);
    expect(empty.lastSeen).toBe(now.toISOString());
  });
});
