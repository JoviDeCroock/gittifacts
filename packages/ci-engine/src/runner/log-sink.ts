/**
 * Streaming uploads to R2 without holding data in Durable Object memory: step logs (redacted,
 * capped) and build artifacts.
 */

export type LogBucket = Pick<R2Bucket, "put" | "createMultipartUpload">;

export const DEFAULT_MAX_LOG_BYTES = 20 * 1024 * 1024;
/** R2 requires every part but the last to be the same size and at least 5 MiB. */
export const DEFAULT_PART_BYTES = 5 * 1024 * 1024;

export interface LogSinkResult {
  key: string;
  /** Bytes stored (including any truncation marker). */
  bytes: number;
  truncated: boolean;
}

/**
 * Buffers bytes and uploads them to R2 without knowing the total size up front: one `put` when it
 * all fits in a part, otherwise a multipart upload of fixed-size parts. Not reentrant: callers
 * serialize `append`/`close`.
 */
export class R2ChunkedUpload {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private stored = 0;
  private upload: R2MultipartUpload | null = null;
  private readonly parts: R2UploadedPart[] = [];
  private finished = false;

  constructor(
    private readonly bucket: LogBucket,
    readonly key: string,
    private readonly opts: { partBytes?: number; contentType: string },
  ) {}

  private get partBytes(): number {
    return this.opts.partBytes ?? DEFAULT_PART_BYTES;
  }

  /** Bytes appended so far. */
  get size(): number {
    return this.stored + this.buffered;
  }

  async append(bytes: Uint8Array): Promise<void> {
    if (this.finished) throw new Error(`upload of ${this.key} is finished`);
    if (bytes.byteLength > 0) {
      this.chunks.push(bytes);
      this.buffered += bytes.byteLength;
    }
    while (this.buffered >= this.partBytes) await this.uploadPart(this.take(this.partBytes));
  }

  /** Completes the upload; returns the stored size. */
  async close(): Promise<number> {
    if (this.finished) throw new Error(`upload of ${this.key} is finished`);
    this.finished = true;
    const rest = this.take(this.buffered);
    if (this.upload === null) {
      await this.bucket.put(this.key, rest, {
        httpMetadata: { contentType: this.opts.contentType },
      });
      this.stored += rest.byteLength;
    } else {
      if (rest.byteLength > 0) await this.uploadPart(rest);
      await this.upload.complete(this.parts);
    }
    return this.stored;
  }

  /** Best effort: drops a half-finished multipart upload. */
  async abort(): Promise<void> {
    this.finished = true;
    this.chunks = [];
    this.buffered = 0;
    if (this.upload !== null) {
      try {
        await this.upload.abort();
      } catch {
        // already completed or aborted
      }
    }
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0]!;
      const need = n - filled;
      if (head.byteLength <= need) {
        out.set(head, filled);
        filled += head.byteLength;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.chunks[0] = head.subarray(need);
        filled += need;
      }
    }
    this.buffered -= n;
    return out;
  }

  private async uploadPart(bytes: Uint8Array): Promise<void> {
    this.upload ??= await this.bucket.createMultipartUpload(this.key, {
      httpMetadata: { contentType: this.opts.contentType },
    });
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, bytes));
    this.stored += bytes.byteLength;
  }
}

/**
 * A step log: text in, capped at `maxBytes` (later output is dropped and a truncation marker is
 * written; the caller keeps draining the process). Writes and close are serialized because
 * process output and platform notes arrive concurrently.
 */
export class R2LogSink {
  private readonly encoder = new TextEncoder();
  private readonly upload: R2ChunkedUpload;
  private written = 0;
  private truncated = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    bucket: LogBucket,
    readonly key: string,
    private readonly opts: { maxBytes?: number; partBytes?: number } = {},
  ) {
    this.upload = new R2ChunkedUpload(bucket, key, {
      ...(opts.partBytes === undefined ? {} : { partBytes: opts.partBytes }),
      contentType: "text/plain; charset=utf-8",
    });
  }

  private get maxBytes(): number {
    return this.opts.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  }

  get isTruncated(): boolean {
    return this.truncated;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  write(text: string): Promise<void> {
    return this.serial(() => this.writeNow(text));
  }

  close(): Promise<LogSinkResult> {
    return this.serial(async () => {
      if (this.closed) throw new Error("log sink is closed");
      this.closed = true;
      const bytes = await this.upload.close();
      return { key: this.key, bytes, truncated: this.truncated };
    });
  }

  async abort(): Promise<void> {
    this.closed = true;
    await this.upload.abort();
  }

  private async writeNow(text: string): Promise<void> {
    if (this.closed) throw new Error("log sink is closed");
    if (this.truncated || text === "") return;
    let bytes = this.encoder.encode(text);
    const room = this.maxBytes - this.written;
    if (bytes.byteLength > room) {
      bytes = bytes.subarray(0, Math.max(0, room));
      this.truncated = true;
    }
    this.written += bytes.byteLength;
    await this.upload.append(bytes);
    if (this.truncated) {
      await this.upload.append(
        this.encoder.encode(`\n[gittifacts: log truncated at ${this.maxBytes} bytes]\n`),
      );
    }
  }
}

/** Keeps the last `maxChars` characters of a text stream. */
export class TailBuffer {
  private text = "";
  constructor(private readonly maxChars = 16 * 1024) {}
  push(s: string): void {
    this.text = (this.text + s).slice(-this.maxChars);
  }
  toString(): string {
    return this.text;
  }
}

export const EVIDENCE_LINE_PREFIX = "::evidence::";

/**
 * Remembers the last line starting with `::evidence::`: the only evidence channel the opt-in
 * `@cloudflare/ci` adapter has. The Runner never uses it (repository code shares that output).
 * Lines longer than `maxLine` are discarded and flagged.
 */
export class EvidenceLineScanner {
  private partial = "";
  private partialOverflow = false;
  private last: string | null = null;
  overflowed = false;

  constructor(private readonly maxLine = 4 * 1024 * 1024) {}

  push(text: string): void {
    const parts = (this.partial + text).split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      if (!this.partialOverflow) this.consider(line);
      this.partialOverflow = false;
    }
    if (this.partial.length > this.maxLine) {
      if (this.partial.startsWith(EVIDENCE_LINE_PREFIX)) this.overflowed = true;
      this.partial = "";
      this.partialOverflow = true;
    }
  }

  finish(): string | null {
    if (!this.partialOverflow) this.consider(this.partial);
    this.partial = "";
    return this.last;
  }

  private consider(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(EVIDENCE_LINE_PREFIX)) this.last = line.slice(EVIDENCE_LINE_PREFIX.length);
  }
}
