/**
 * `GithubWriteGate`: one Durable Object per GitHub App installation that serializes our writes to
 * GitHub across every isolate and keeps them inside the secondary limits (≤ 80 content writes a
 * minute, ≤ 500 an hour; docs/research/github-app.md §5, decision 6).
 *
 * A writer `acquire`s a lease, makes its one write, and `release`s it. The next lease is granted
 * only after the previous one is released (or 15 s later, if the writer died). The write times
 * live in DO storage, so the budget survives eviction; a lease that would wait more than 20 s is
 * refused with a retry-after instead (the queue message retries later).
 */
import { DurableObject } from "cloudflare:workers";
import { GithubRateLimited, type WriteGate, WriteGovernor } from "@app/host-github";

const LEASE_MS = 15_000;

export type Lease = { ok: true; lease: string } | { ok: false; retryAfterSec: number };

export class GithubWriteGate extends DurableObject {
  private readonly leases = new Map<string, () => void>();
  private readonly governor = new WriteGovernor({
    maxWaitMs: 20_000,
    store: {
      load: async () => (await this.ctx.storage.get<number[]>("times")) ?? [],
      save: async (times) => this.ctx.storage.put("times", times),
    },
  });

  acquire(): Promise<Lease> {
    return new Promise<Lease>((resolve) => {
      this.governor
        .run(
          () =>
            new Promise<void>((done) => {
              const lease = crypto.randomUUID();
              const timer = setTimeout(() => {
                this.leases.delete(lease);
                done();
              }, LEASE_MS);
              this.leases.set(lease, () => {
                clearTimeout(timer);
                this.leases.delete(lease);
                done();
              });
              resolve({ ok: true, lease });
            }),
        )
        .catch((e: unknown) => {
          resolve({ ok: false, retryAfterSec: e instanceof GithubRateLimited ? e.retryAfterSec : 60 });
        });
    });
  }

  release(lease: string): void {
    this.leases.get(lease)?.();
  }
}

/** The installation's gate as a `WriteGate` for the GitHub client. */
export function durableWriteGate(
  ns: DurableObjectNamespace<GithubWriteGate>,
  installationId: number,
): WriteGate {
  return {
    async run<T>(write: () => Promise<T>): Promise<T> {
      const stub = ns.get(ns.idFromName(`installation:${installationId}`));
      const lease = await stub.acquire();
      if (!lease.ok) throw new GithubRateLimited(lease.retryAfterSec);
      try {
        return await write();
      } finally {
        await stub.release(lease.lease);
      }
    },
  };
}
