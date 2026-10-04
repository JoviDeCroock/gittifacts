/**
 * Waiting without fixed sleeps (docs/testing.md, flake policy): poll a condition until it holds
 * or a deadline passes, backing off from 250 ms to 5 s. The error names what was awaited and the
 * last value seen, so a timeout explains itself.
 */
export interface PollOptions {
  /** Total budget in ms. */
  timeoutMs: number;
  /** What is being awaited, for the error message. */
  what: string;
  minIntervalMs?: number;
  maxIntervalMs?: number;
}

export async function pollUntil<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs, what, minIntervalMs = 250, maxIntervalMs = 5_000 }: PollOptions,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let interval = minIntervalMs;
  let last: T | undefined;
  let lastError: unknown;
  for (;;) {
    try {
      last = await probe();
      lastError = undefined;
      if (done(last)) return last;
    } catch (err) {
      lastError = err;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      const seen = lastError !== undefined ? `last error: ${String(lastError)}` : `last value: ${JSON.stringify(last)?.slice(0, 500)}`;
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what} (${seen})`);
    }
    await new Promise((r) => setTimeout(r, Math.min(interval, left)));
    interval = Math.min(interval * 2, maxIntervalMs);
  }
}

/** A name no other test (or run) uses: tests never share data. */
export function uniqueName(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}
