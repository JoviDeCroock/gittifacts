import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/app-env.js";
import { runGithubRedeliveries } from "../src/github/redeliver.js";
import { recordDelivery } from "../src/github/store.js";
import { store } from "./fixtures.js";
import { jsonRes, seedSigningApp, stubGithub } from "./github-helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("cron: redeliver failed GitHub deliveries", () => {
  it("asks GitHub again for recent failures we never recorded, once each, never pings", async () => {
    const appId = await seedSigningApp();
    const now = new Date("2026-10-03T12:00:00Z");
    const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    await recordDelivery(store().db, { id: "guid-recorded", appId, event: "push", action: null, installationId: 1, receivedAt: at(1) });
    const d = (id: number, guid: string, status_code: number, hoursAgo: number, event = "pull_request") => ({
      id, guid, delivered_at: at(hoursAgo), redelivery: false, status_code, event, action: "opened",
    });
    const asked: string[] = [];
    stubGithub({
      "GET https://api.github.com/app/hook/deliveries": (req) => {
        expect(req.headers.get("authorization")).toMatch(/^Bearer ey/);
        return jsonRes([
          d(1, "guid-queue-down", 503, 2),
          d(2, "guid-timeout", 0, 3),
          d(3, "guid-recorded", 503, 1),
          d(4, "guid-old", 503, 80),
          d(5, "guid-ping", 401, 1, "ping"),
          d(6, "guid-ok", 202, 1),
          d(7, "guid-retried", 503, 5),
          { ...d(8, "guid-retried", 202, 4), redelivery: true },
        ]);
      },
      ...Object.fromEntries([1, 2, 3, 4, 5, 7].map((id) => [
        `POST https://api.github.com/app/hook/deliveries/${id}/attempts`,
        () => (asked.push(String(id)), jsonRes({}, 202)),
      ])),
    });
    expect(await runGithubRedeliveries(env as Bindings, now)).toBe(2);
    expect(asked.sort()).toEqual(["1", "2"]);
  });
});
