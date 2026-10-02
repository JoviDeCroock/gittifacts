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

  async getProposal(): Promise<ProposalPointer | null> {
    const parsed = ProposalPointer.safeParse(await this.ctx.storage.get("proposal"));
    return parsed.success ? parsed.data : null;
  }

  async setProposal(pointer: ProposalPointer): Promise<void> {
    await this.ctx.storage.put("proposal", ProposalPointer.parse(pointer));
  }
}
