import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeExpired, RETENTION_DAYS } from "../src/retention.js";
import { createDb } from "../src/store/d1-store.js";
import { call, createAgent, makeApp, signUpHuman } from "./http.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

async function token(
  principalId: string,
  id: string,
  f: { expiresAt?: string; revokedAt?: string },
) {
  await env.DB.prepare(
    "INSERT INTO agent_tokens (id, principal_id, token_hash, prefix, scopes, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, '[]', ?, ?, ?)",
  )
    .bind(
      id,
      principalId,
      `hash-${id}`,
      "gtf_x",
      daysAgo(90),
      f.expiresAt ?? null,
      f.revokedAt ?? null,
    )
    .run();
}

async function delivery(
  integrationId: string,
  id: string,
  status: string,
  createdAt: string,
  lastAttemptAt: string | null = null,
) {
  await env.DB.prepare(
    "INSERT INTO webhook_deliveries (id, guid, integration_id, event, payload, status, attempts, created_at, last_attempt_at) VALUES (?, ?, ?, 'change.merged', '{}', ?, 1, ?, ?)",
  )
    .bind(id, id, integrationId, status, createdAt, lastAttemptAt)
    .run();
}

const ids = async (table: string, like: string) =>
  (
    await env.DB.prepare(`SELECT id FROM ${table} WHERE id LIKE ? ORDER BY id`)
      .bind(like)
      .all<{ id: string }>()
  ).results.map((r) => r.id);

describe("retention (cron)", () => {
  it("purges agent tokens and finished webhook deliveries 30 days after they ended, nothing else", async () => {
    const { app } = makeApp();
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    const p = agent.principal.id;
    const old = daysAgo(RETENTION_DAYS + 1);
    const recent = daysAgo(RETENTION_DAYS - 1);
    await token(p, "rt-expired-old", { expiresAt: old });
    await token(p, "rt-revoked-old", { revokedAt: old });
    await token(p, "rt-expired-recent", { expiresAt: recent });
    await token(p, "rt-revoked-recent", { revokedAt: recent });
    await token(p, "rt-live", { expiresAt: daysAgo(-30) });
    await token(p, "rt-no-expiry", {});

    await env.DB.prepare(
      "INSERT INTO integrations (id, client_id, owner_id, name, homepage_url, redirect_uris, client_type, scopes, webhook_events, created_at, updated_at) VALUES ('rt-int', 'gtic_rt', ?, 'rt', 'https://rt.example', '[]', 'public', '[]', '[]', ?, ?)",
    )
      .bind(human.principal.id, old, old)
      .run();
    await delivery("rt-int", "rt-d-delivered-old", "delivered", old);
    await delivery("rt-int", "rt-d-failed-old", "failed", old);
    await delivery("rt-int", "rt-d-cancelled-old", "cancelled", old);
    await delivery("rt-int", "rt-d-pending-old", "pending", old);
    await delivery("rt-int", "rt-d-delivered-recent", "delivered", recent);
    // Created long ago but retried until recently: aged by its last attempt, so it stays.
    await delivery("rt-int", "rt-d-failed-late", "failed", old, recent);
    await delivery("rt-int", "rt-d-failed-old-attempt", "failed", old, old);

    const db = createDb(env.DB);
    expect(await purgeExpired(db, NOW)).toEqual({ agentTokens: 2, webhookDeliveries: 4 });
    expect(await ids("agent_tokens", "rt-%")).toEqual([
      "rt-expired-recent",
      "rt-live",
      "rt-no-expiry",
      "rt-revoked-recent",
    ]);
    expect(await ids("webhook_deliveries", "rt-d-%")).toEqual([
      "rt-d-delivered-recent",
      "rt-d-failed-late",
      "rt-d-pending-old",
    ]);
    // Idempotent; and the agent's own (live) token still authenticates.
    expect(await purgeExpired(db, NOW)).toEqual({ agentTokens: 0, webhookDeliveries: 0 });
    expect((await call(app, "GET", "/api/v1/me", { token: agent.token })).status).toBe(200);
  });

  it("deletes at most `limit` rows per table per run, so a backlog drains over several runs", async () => {
    const { app } = makeApp();
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    for (let i = 0; i < 5; i++)
      await token(agent.principal.id, `rb-${i}`, { revokedAt: daysAgo(RETENTION_DAYS + 2) });
    const db = createDb(env.DB);
    expect((await purgeExpired(db, NOW, { limit: 3 })).agentTokens).toBe(3);
    expect((await purgeExpired(db, NOW, { limit: 3 })).agentTokens).toBe(2);
    expect(await ids("agent_tokens", "rb-%")).toEqual([]);
  });
});
