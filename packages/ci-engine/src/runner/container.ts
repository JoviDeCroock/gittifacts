/**
 * The container seam. In production this is `ctx.container` (`scheduling_policy: "durable_object"`);
 * tests inject a fake because the Workers test runtime has no containers.
 */

export interface ExecProcessLike {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;
}

export interface ContainerLike {
  readonly running: boolean;
  readonly images: Record<string, string>;
  start(options: ContainerStartupOptions): void;
  monitor(): Promise<void>;
  exec(cmd: string[], options?: ContainerExecOptions): Promise<ExecProcessLike>;
  snapshotContainer(options: {
    name?: string;
  }): Promise<{ id: string; size: number; name?: string }>;
  destroy(reason?: unknown): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
  /** Routes all plain-HTTP egress to `binding`. */
  interceptAllOutboundHttp(binding: Fetcher): Promise<void>;
  /** Routes HTTPS egress for `addr` (`"*"`: every host) to `binding`, terminating TLS. */
  interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void>;
}

/**
 * Reads a byte stream as UTF-8 text, calling `onText` per decoded chunk. Never buffers the whole
 * stream. Resolves when the stream ends; rejects if it errors.
 */
export async function pumpText(
  stream: ReadableStream<Uint8Array> | null,
  onText: (text: string) => Promise<void> | void,
): Promise<void> {
  if (stream === null) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text !== "") await onText(text);
    }
    const rest = decoder.decode();
    if (rest !== "") await onText(rest);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Reads up to `maxBytes` of a stream as text and drains (discards) the rest, so a chatty process
 * can't block on a full pipe or fill Durable Object memory.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (stream === null) return { text: "", bytes: 0, truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (kept < maxBytes) {
        const slice = value.subarray(0, maxBytes - kept);
        chunks.push(slice);
        kept += slice.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const buf = new Uint8Array(kept);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf), bytes: total, truncated: total > maxBytes };
}

/** Rejects after `ms` with `message`; `clear()` cancels it. */
export function deadline(
  ms: number,
  message: string,
): { promise: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(message)), ms);
  });
  // Avoid unhandled rejections when nobody races it any more.
  promise.catch(() => {});
  return {
    promise,
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export class DeadlineError extends Error {
  override readonly name = "DeadlineError";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}
