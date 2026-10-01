/**
 * `GET /api/v1/changes/:changeId/events`: a change's updates as Server-Sent Events.
 *
 * Built on `CoordinatorApi.watchChange`, a long-poll held by the change's Durable Object, so it
 * works across isolates. Each event carries the full change; its `id` is the change version, so a
 * client that reconnects with `Last-Event-ID` only gets what it missed. Quiet periods send a
 * comment line as a heartbeat. The stream ends when the client goes away, after `maxMs`, or once
 * the change reached a final status (after sending it).
 */
import { FINAL_STATUSES } from "@app/coordinator";
import type { Change } from "@app/domain";
import type { Caller, Services } from "../app-env.js";

export const CHANGE_EVENTS_MAX_MS = 15 * 60_000;
const POLL_MS = 25_000;
/** Version strings come from `changeVersion` (16 hex chars); anything else starts over. */
const VERSION = /^[0-9a-f]{16}$/;

export interface ChangeEventStreamOptions {
  since: string | null;
  signal?: AbortSignal;
  /** Long-poll length per round (also the heartbeat interval). */
  pollMs?: number;
  maxMs?: number;
  now?: () => number;
}

export function sseEvent(event: string, data: unknown, id?: string): string {
  const lines = [...(id ? [`id: ${id}`] : []), `event: ${event}`];
  for (const line of JSON.stringify(data).split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

export function changeEventStream(
  svc: Pick<Services, "coordinator">,
  caller: Caller,
  changeId: string,
  opts: ChangeEventStreamOptions,
): Response {
  const encoder = new TextEncoder();
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.maxMs ?? CHANGE_EVENTS_MAX_MS);
  const pollMs = opts.pollMs ?? POLL_MS;
  let since = opts.since !== null && VERSION.test(opts.since) ? opts.since : null;
  let finished = false;
  let first = true;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first) {
        first = false;
        controller.enqueue(encoder.encode("retry: 3000\n\n"));
      }
      if (finished || opts.signal?.aborted === true || now() >= deadline) {
        controller.close();
        return;
      }
      try {
        const remaining = Math.max(0, deadline - now());
        const r = await svc.coordinator.watchChange(caller.principal, changeId, {
          since,
          timeoutMs: Math.min(pollMs, remaining),
        });
        if (r.changed || since === null) {
          controller.enqueue(encoder.encode(sseEvent("change", { change: r.change }, r.version)));
          since = r.version;
          if (FINAL_STATUSES.includes(r.change.status as Change["status"])) finished = true;
        } else {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(sseEvent("error", { message })));
        controller.close();
      }
    },
    cancel() {
      finished = true;
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
