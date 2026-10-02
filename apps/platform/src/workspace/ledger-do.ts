/**
 * `ProjectLedger`: one Durable Object per project (repo id), the single writer of what a project
 * has used of its remote-workspace quota and which of its workspaces are open, plus where its
 * latest `.platform` proposal is. Strongly consistent per project, so two agents can't both slip
 * under a limit.
 *
 * Usage is recorded in vCPU-seconds of container time (container wall time × the instance's
 * vCPUs): the closest thing to "CPU minutes" `ctx.container` lets the platform measure, and what
 * Containers bill. Days are UTC.
 */
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

const DayUsage = z.object({
  cpuSeconds: z.number().nonnegative(),
  containerSeconds: z.number().nonnegative(),
});
type DayUsage = z.infer<typeof DayUsage>;

export const ProposalPointer = z.object({
  proposalId: z.string().min(1).max(200),
  baseSha: z.string().nullable(),
  startedAt: z.string(),
  requestedBy: z.string(),
});
export type ProposalPointer = z.infer<typeof ProposalPointer>;

const CiReservation = z.object({
  minutes: z.number().nonnegative(),
  day: z.string(),
  settled: z.boolean(),
});
type CiReservation = z.infer<typeof CiReservation>;

export interface LedgerUsage {
  day: string;
  cpuSecondsUsed: number;
  containerSecondsUsed: number;
  /** null: unlimited. */
  cpuSecondsRemaining: number | null;
  open: string[];
}

const dayOf = (atMs: number) => new Date(atMs).toISOString().slice(0, 10);

export class ProjectLedger extends DurableObject<unknown> {
  private async openSet(): Promise<string[]> {
    const raw = await this.ctx.storage.get("open");
    return z
      .array(z.string())
      .catch([])
      .parse(raw ?? []);
  }

  /** Registers an open workspace; refuses once `maxOpen` other workspaces are open. */
  async reserve(input: {
    workspaceId: string;
    maxOpen: number;
  }): Promise<{ ok: true } | { ok: false; open: string[] }> {
    const open = await this.openSet();
    if (open.includes(input.workspaceId)) return { ok: true };
    if (open.length >= input.maxOpen) return { ok: false, open };
    await this.ctx.storage.put("open", [...open, input.workspaceId]);
    return { ok: true };
  }

  async release(workspaceId: string): Promise<void> {
    const open = await this.openSet();
    if (open.includes(workspaceId)) {
      await this.ctx.storage.put(
        "open",
        open.filter((w) => w !== workspaceId),
      );
    }
  }

  async recordUsage(input: {
    workspaceId: string;
    cpuSeconds: number;
    containerSeconds: number;
    atMs: number;
  }): Promise<void> {
    if (!(input.cpuSeconds > 0) && !(input.containerSeconds > 0)) return;
    const key = `usage:${dayOf(input.atMs)}`;
    const prev = DayUsage.catch({ cpuSeconds: 0, containerSeconds: 0 }).parse(
      (await this.ctx.storage.get(key)) ?? {},
    );
    const next: DayUsage = {
      cpuSeconds: prev.cpuSeconds + Math.max(0, input.cpuSeconds),
      containerSeconds: prev.containerSeconds + Math.max(0, input.containerSeconds),
    };
    await this.ctx.storage.put(key, next);
  }

  async usage(input: { cpuSecondsPerDay: number | null; atMs: number }): Promise<LedgerUsage> {
    const day = dayOf(input.atMs);
    const used = DayUsage.catch({ cpuSeconds: 0, containerSeconds: 0 }).parse(
      (await this.ctx.storage.get(`usage:${day}`)) ?? {},
    );
    return {
      day,
      cpuSecondsUsed: used.cpuSeconds,
      containerSecondsUsed: used.containerSeconds,
      cpuSecondsRemaining:
        input.cpuSecondsPerDay === null
          ? null
          : Math.max(0, input.cpuSecondsPerDay - used.cpuSeconds),
      open: await this.openSet(),
    };
  }

  // ------------------------------------------------------------ O3 quotas (src/limits/quotas.ts)
  // Generic counters for unclaimed projects (named by repo id) and per-IP aggregates (named
  // `ip:<hash>`): `day` counters reset at 00:00 UTC, `total` counters never do. Every check-and-
  // charge is one DO call, so concurrent callers can't both slip under a limit.

  private counterKey(metric: string, period: "day" | "total", atMs: number): string {
    return period === "day" ? `q:${dayOf(atMs)}:${metric}` : `q:total:${metric}`;
  }

  private async counter(key: string): Promise<number> {
    return z
      .number()
      .catch(0)
      .parse((await this.ctx.storage.get(key)) ?? 0);
  }

  /** Charge `amount` if it fits under `limit` (null: unlimited); otherwise change nothing. */
  async charge(input: {
    metric: string;
    amount: number;
    limit: number | null;
    period: "day" | "total";
    atMs: number;
  }): Promise<{ ok: boolean; used: number; limit: number | null }> {
    const key = this.counterKey(input.metric, input.period, input.atMs);
    const used = await this.counter(key);
    const amount = Math.max(0, input.amount);
    if (input.limit !== null && used + amount > input.limit) {
      return { ok: false, used, limit: input.limit };
    }
    await this.ctx.storage.put(key, used + amount);
    return { ok: true, used: used + amount, limit: input.limit };
  }

  /** Record usage measured after the fact (e.g. bytes a CI run stored); never refuses. */
  async add(input: {
    metric: string;
    amount: number;
    period: "day" | "total";
    atMs: number;
  }): Promise<number> {
    const key = this.counterKey(input.metric, input.period, input.atMs);
    const next = Math.max(0, (await this.counter(key)) + input.amount);
    await this.ctx.storage.put(key, next);
    return next;
  }

  async counters(input: {
    metrics: ReadonlyArray<{ metric: string; period: "day" | "total" }>;
    atMs: number;
  }): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const m of input.metrics) {
      out[m.metric] = await this.counter(this.counterKey(m.metric, m.period, input.atMs));
    }
    return out;
  }

  /**
   * Reserve CI minutes for one run: up to `maxMinutes`, never more than what is left of
   * `perDay` today. Idempotent per run id (a retried start gets the same grant). Refused when
   * fewer than `minMinutes` are left.
   */
  async reserveCi(input: {
    runId: string;
    maxMinutes: number;
    perDay: number;
    minMinutes: number;
    atMs: number;
  }): Promise<{ ok: true; minutes: number } | { ok: false; usedMinutes: number }> {
    const prev = CiReservation.safeParse(await this.ctx.storage.get(`ci:${input.runId}`));
    if (prev.success) return { ok: true, minutes: prev.data.minutes };
    const key = this.counterKey("ci-minutes", "day", input.atMs);
    const used = await this.counter(key);
    const minutes = Math.min(input.maxMinutes, Math.floor(input.perDay - used));
    if (minutes < input.minMinutes) return { ok: false, usedMinutes: used };
    await this.ctx.storage.put(key, used + minutes);
    await this.ctx.storage.put(`ci:${input.runId}`, {
      minutes,
      day: dayOf(input.atMs),
      settled: false,
    } satisfies CiReservation);
    return { ok: true, minutes };
  }

  /** Replace a run's reservation with what it actually used (capped at the grant). Once. */
  async settleCi(input: { runId: string; actualMinutes: number }): Promise<boolean> {
    const parsed = CiReservation.safeParse(await this.ctx.storage.get(`ci:${input.runId}`));
    if (!parsed.success || parsed.data.settled) return false;
    const r = parsed.data;
    const actual = Math.min(r.minutes, Math.max(0, input.actualMinutes));
    const key = `q:${r.day}:ci-minutes`;
    await this.ctx.storage.put(key, Math.max(0, (await this.counter(key)) - r.minutes + actual));
    await this.ctx.storage.put(`ci:${input.runId}`, { ...r, settled: true });
    return true;
  }

  async getProposal(): Promise<ProposalPointer | null> {
    const parsed = ProposalPointer.safeParse(await this.ctx.storage.get("proposal"));
    return parsed.success ? parsed.data : null;
  }

  async setProposal(pointer: ProposalPointer): Promise<void> {
    await this.ctx.storage.put("proposal", ProposalPointer.parse(pointer));
  }
}
