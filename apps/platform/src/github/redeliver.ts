/**
 * Cron: ask GitHub to redeliver webhook deliveries that failed on our side (research §4,
 * decision 7). "GitHub does not automatically redeliver failed deliveries", and our receiver
 * answers 503 when it couldn't queue one. Per App: `GET /app/hook/deliveries` (App JWT), and for
 * each failed delivery from the last 3 days whose GUID we never recorded, `POST
 * /app/hook/deliveries/{id}/attempts`. At most 10 a run; the receiver dedupes whatever comes twice.
 */
import { GITHUB_API_VERSION, InstallationTokens } from "@app/host-github";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { Bindings } from "../app-env.js";
import { githubDeliveries } from "../db/github-schema.js";
import { D1Store } from "../store/d1-store.js";
import { githubApp } from "./app-config.js";

const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 10;

const Delivery = z.object({
  id: z.number(),
  guid: z.string(),
  delivered_at: z.string(),
  redelivery: z.boolean(),
  status_code: z.number(),
  event: z.string(),
});

export async function runGithubRedeliveries(env: Bindings, now = new Date()): Promise<number> {
  const db = new D1Store(env.DB, env.BLOBS, () => now).db;
  let asked = 0;
  const cfg = env as unknown as Record<string, unknown>;
  for (const kind of ["reader", "actor"] as const) {
    const app = githubApp(cfg, kind);
    if (app === null || asked >= MAX_PER_RUN) continue;
    try {
      const jwt = await new InstallationTokens({
        appId: app.appId,
        clientId: app.clientId,
        privateKey: app.privateKey,
      }).appJwt();
      const headers = {
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
        authorization: `Bearer ${jwt}`,
        "user-agent": "gittifacts",
      };
      const res = await fetch("https://api.github.com/app/hook/deliveries?per_page=100", {
        headers,
      });
      if (!res.ok) {
        await res.body?.cancel();
        continue;
      }
      const list = z.array(Delivery).safeParse(await res.json());
      if (!list.success) continue;
      const failed = list.data.filter(
        (d) =>
          (d.status_code === 0 || d.status_code >= 500 || d.status_code === 429) &&
          d.event !== "ping" &&
          now.getTime() - Date.parse(d.delivered_at) < WINDOW_MS,
      );
      if (failed.length === 0) continue;
      const seen = new Set(
        (
          await db
            .select({ id: githubDeliveries.id })
            .from(githubDeliveries)
            .where(
              inArray(
                githubDeliveries.id,
                failed.map((d) => d.guid),
              ),
            )
            .all()
        ).map((r) => r.id),
      );
      // One attempt per GUID: a GUID that already succeeded (or whose redelivery is pending) is skipped.
      const succeeded = new Set(
        list.data.filter((d) => d.status_code >= 200 && d.status_code < 300).map((d) => d.guid),
      );
      for (const d of failed) {
        if (asked >= MAX_PER_RUN || seen.has(d.guid) || succeeded.has(d.guid)) continue;
        const r = await fetch(`https://api.github.com/app/hook/deliveries/${d.id}/attempts`, {
          method: "POST",
          headers,
        });
        await r.body?.cancel();
        succeeded.add(d.guid);
        asked++;
      }
    } catch (e) {
      console.error("github redelivery sweep failed", app.appId, (e as Error).message);
    }
  }
  return asked;
}
