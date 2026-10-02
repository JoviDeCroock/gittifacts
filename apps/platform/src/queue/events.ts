/**
 * `GET /api/v1/repos/:repoId/queue/events`: the merge queue's §5 events (`entered_batch`,
 * `resolving_conflict`, `resolution_ready`, `ejected`, `merged`, `deployed`, `flag_killed`,
 * `frozen`, `thawed`) as Server-Sent Events. Each event's `id` is its sequence number in the
 * queue's DO, so a client that reconnects with `Last-Event-ID` (or `?since=`) gets what it
 * missed (the DO keeps the newest 5000). Long-polls are held by the DO; quiet rounds send a
 * heartbeat comment. The stream ends after 15 minutes.
 */
import type { Services } from "../app-env.js";
import { sseEvent } from "../services/events.js";
import { queueOf } from "./service.js";

export const QUEUE_EVENTS_MAX_MS = 15 * 60_000;
const POLL_MS = 25_000;

export function queueEventStream(
  svc: Services,
  repoId: string,
  opts: {
    since: string | null;
    changeId?: string;
    signal?: AbortSignal;
    pollMs?: number;
    maxMs?: number;
    now?: () => number;
  },
): Response {
  const encoder = new TextEncoder();
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.maxMs ?? QUEUE_EVENTS_MAX_MS);
  const parsed = opts.since === null ? Number.NaN : Number(opts.since);
  let since = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  let first = true;
  let done = false;
  const queue = queueOf(svc, repoId);

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first) {
        first = false;
        controller.enqueue(encoder.encode("retry: 3000\n\n"));
      }
      if (done || opts.signal?.aborted === true || now() >= deadline) {
        controller.close();
        return;
      }
      try {
        const r = await queue.queueEvents(repoId, {
          since,
          timeoutMs: Math.min(opts.pollMs ?? POLL_MS, Math.max(0, deadline - now())),
          ...(opts.changeId === undefined ? {} : { changeId: opts.changeId }),
        });
        if (r.events.length === 0) controller.enqueue(encoder.encode(": keep-alive\n\n"));
        for (const e of r.events)
          controller.enqueue(encoder.encode(sseEvent("queue", e.data, String(e.seq))));
        since = Math.max(since, r.last);
      } catch (e) {
        controller.enqueue(
          encoder.encode(
            sseEvent("error", { message: e instanceof Error ? e.message : String(e) }),
          ),
        );
        controller.close();
      }
    },
    cancel() {
      done = true;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
