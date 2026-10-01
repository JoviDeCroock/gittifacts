/** App state as signals. Plain functions, so tests can run them without a DOM. */
import { computed, signal } from "@preact/signals";

export function createCounter(initial = 0) {
  const count = signal(initial);
  const double = computed(() => count.value * 2);
  return {
    count,
    double,
    increment: () => {
      count.value += 1;
    },
    reset: () => {
      count.value = initial;
    },
  };
}

export type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
};

/** Server time from GET /api/time. `error` is set instead of throwing. */
export function createServerClock(fetchJson: FetchJson = defaultFetchJson) {
  const now = signal<string | null>(null);
  const error = signal<string | null>(null);
  return {
    now,
    error,
    async refresh(): Promise<void> {
      try {
        const body = await fetchJson("/api/time");
        if (typeof body !== "object" || body === null || !("now" in body) || typeof body.now !== "string") {
          throw new Error("unexpected response from /api/time");
        }
        now.value = body.now;
        error.value = null;
      } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
      }
    },
  };
}
