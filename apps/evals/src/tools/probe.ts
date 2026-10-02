/**
 * Preview probes: is a preview URL serving "the current time"? Used during the run (to time the
 * first green) and by the task-1/4 checker. Green = HTTP 200 and a body with an ISO 8601
 * timestamp within ±10 minutes of the probe (so a hard-coded date or a "Building…" page is not
 * green).
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const ISO =
  /\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})\b/g;
export const CURRENT_WINDOW_MS = 10 * 60_000;

/** The first ISO timestamp (with a zone) in `text` that is within the window of `nowMs`. */
export function currentIsoTimestamp(text: string, nowMs: number): string | null {
  for (const m of text.matchAll(ISO)) {
    const zone =
      m[7]!.length === 5 && m[7] !== "Z" ? `${m[7]!.slice(0, 3)}:${m[7]!.slice(3)}` : m[7]!;
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${zone}`;
    const t = Date.parse(iso);
    if (Number.isFinite(t) && Math.abs(t - nowMs) <= CURRENT_WINDOW_MS) return m[0];
  }
  return null;
}

export interface ProbeResult {
  url: string;
  green: boolean;
  status: number | null;
  detail: string;
  at: number;
}

export async function probePreview(
  fetcher: FetchLike,
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<ProbeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetcher(url, {
      headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.5", ...opts.headers },
      redirect: "follow",
      signal: ac.signal,
    });
    const body = (await res.text()).slice(0, 64 * 1024);
    const at = Date.now();
    if (res.status !== 200) {
      return { url, green: false, status: res.status, detail: `HTTP ${res.status}`, at };
    }
    const ts = currentIsoTimestamp(body, at);
    return ts
      ? { url, green: true, status: 200, detail: `serves ${ts}`, at }
      : { url, green: false, status: 200, detail: "HTTP 200 without a current ISO timestamp", at };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { url, green: false, status: null, detail: `fetch failed: ${msg}`, at: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}
