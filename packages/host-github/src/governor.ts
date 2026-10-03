/**
 * Per-installation write governor (docs/research/github-app.md §5, decision 6): GitHub's
 * secondary limits allow ≤ 80 content-creating requests a minute and ≤ 500 an hour. Writes run
 * one at a time (serialized per installation); a write that would exceed a budget waits when the
 * wait is short, and otherwise fails with `GithubRateLimited` so the caller retries later (a queue
 * message's delay), never hammering GitHub.
 */

export class GithubRateLimited extends Error {
  constructor(
    readonly retryAfterSec: number,
    message = `GitHub rate limit: retry in ${retryAfterSec} s`,
  ) {
    super(message);
    this.name = "GithubRateLimited";
  }
}

/** Where the governor keeps the timestamps of recent writes (memory, or a Durable Object). */
export interface GovernorStore {
  load(): Promise<number[]>;
  save(times: number[]): Promise<void>;
}

export function memoryGovernorStore(): GovernorStore {
  let times: number[] = [];
  return {
    load: async () => times,
    save: async (t) => {
      times = t;
    },
  };
}

export interface GovernorOptions {
  perMinute?: number;
  perHour?: number;
  /** Longest in-process wait before giving up with GithubRateLimited. */
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  store?: GovernorStore;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** Where a write waits its turn: in memory (one isolate), or a Durable Object per installation. */
export interface WriteGate {
  run<T>(write: () => Promise<T>): Promise<T>;
}

export class WriteGovernor implements WriteGate {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly perMinute: number;
  private readonly perHour: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly store: GovernorStore;

  constructor(opts: GovernorOptions = {}) {
    this.perMinute = opts.perMinute ?? 80;
    this.perHour = opts.perHour ?? 500;
    this.maxWaitMs = opts.maxWaitMs ?? 5_000;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.store = opts.store ?? memoryGovernorStore();
  }

  /** How long until one more write fits both windows (0 = now). */
  waitFor(times: readonly number[], now: number): number {
    const lastHour = times.filter((t) => t > now - HOUR);
    const lastMinute = lastHour.filter((t) => t > now - MINUTE);
    let wait = 0;
    if (lastMinute.length >= this.perMinute) {
      wait = Math.max(wait, (lastMinute[lastMinute.length - this.perMinute] ?? now) + MINUTE - now);
    }
    if (lastHour.length >= this.perHour) {
      wait = Math.max(wait, (lastHour[lastHour.length - this.perHour] ?? now) + HOUR - now);
    }
    return wait;
  }

  /** Run one write: serialized, and inside both budgets. */
  run<T>(write: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => this.runOne(write));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async runOne<T>(write: () => Promise<T>): Promise<T> {
    const times = [...(await this.store.load())].sort((a, b) => a - b);
    const wait = this.waitFor(times, this.now());
    if (wait > this.maxWaitMs) throw new GithubRateLimited(Math.ceil(wait / 1000));
    if (wait > 0) await this.sleep(wait);
    const at = this.now();
    await this.store.save([...times.filter((t) => t > at - HOUR), at]);
    return write();
  }
}
