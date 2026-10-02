/**
 * `AbuseLimiter`: token buckets for credential-less project creation, one Durable Object per key
 * (`ip:<hash>`, `asn:<n>`, `global`). Strongly consistent and global: every request for a key
 * lands on the same object, wherever it entered Cloudflare.
 *
 * Why not the Workers Rate Limiting binding here (DECISIONS.md 2026-10-02, O3): its counters are
 * per Cloudflare location and its period is 10 or 60 seconds. "3 projects per IP per hour",
 * "200 per network per day" and a platform-wide cap need longer windows and one global counter.
 * The binding still guards per-token request rates (src/limits/request-limit.ts), where a short,
 * per-location window is exactly right.
 */
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

const BucketState = z.object({ tokens: z.number(), atMs: z.number() });

export interface BucketSpec {
  /** Stable name of the window ("hour", "day"): one bucket per (key, window). */
  name: string;
  capacity: number;
  periodSec: number;
}

export type TakeResult =
  | { ok: true }
  | { ok: false; window: string; retryAfterSec: number; capacity: number; periodSec: number };

function refill(state: { tokens: number; atMs: number } | null, b: BucketSpec, nowMs: number) {
  if (state === null) return b.capacity;
  const rate = b.capacity / (b.periodSec * 1000);
  return Math.min(b.capacity, state.tokens + Math.max(0, nowMs - state.atMs) * rate);
}

export class AbuseLimiter extends DurableObject<unknown> {
  private async state(name: string): Promise<{ tokens: number; atMs: number } | null> {
    const parsed = BucketState.safeParse(await this.ctx.storage.get(`b:${name}`));
    return parsed.success ? parsed.data : null;
  }

  /**
   * Take `cost` tokens from every bucket, or from none: if any bucket is short, nothing is
   * taken and the caller learns which window refused and when to retry.
   */
  async take(input: { buckets: BucketSpec[]; cost?: number; atMs: number }): Promise<TakeResult> {
    const cost = input.cost ?? 1;
    const levels: Array<{ b: BucketSpec; tokens: number }> = [];
    for (const b of input.buckets) {
      const tokens = refill(await this.state(b.name), b, input.atMs);
      if (tokens < cost) {
        const rate = b.capacity / b.periodSec;
        return {
          ok: false,
          window: b.name,
          retryAfterSec: Math.max(1, Math.ceil((cost - tokens) / rate)),
          capacity: b.capacity,
          periodSec: b.periodSec,
        };
      }
      levels.push({ b, tokens });
    }
    for (const { b, tokens } of levels) {
      await this.ctx.storage.put(`b:${b.name}`, { tokens: tokens - cost, atMs: input.atMs });
    }
    return { ok: true };
  }

  /** Give tokens back (another key refused the same request). */
  async refund(input: { buckets: BucketSpec[]; cost?: number; atMs: number }): Promise<void> {
    const cost = input.cost ?? 1;
    for (const b of input.buckets) {
      const tokens = refill(await this.state(b.name), b, input.atMs);
      await this.ctx.storage.put(`b:${b.name}`, {
        tokens: Math.min(b.capacity, tokens + cost),
        atMs: input.atMs,
      });
    }
  }

  /** Forget every bucket of this key (an operator clearing a key after an incident; tests). */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  /** Current levels (tests and the admin view). */
  async levels(input: { buckets: BucketSpec[]; atMs: number }): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const b of input.buckets) out[b.name] = refill(await this.state(b.name), b, input.atMs);
    return out;
  }
}
