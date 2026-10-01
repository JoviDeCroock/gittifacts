/**
 * AuditLog Durable Object: the single writer of the append-only, hash-chained, signed audit log.
 * One instance per org (the platform uses the name "global" for now).
 *
 * Source of truth is this DO's SQLite storage. Every entry is mirrored to D1 `audit_events` for
 * queries; a failed mirror write is retried on the next append and by an alarm, so the mirror is
 * eventually complete and never reordered (rows are keyed by seq).
 */
import type { AuditEvent } from "@app/domain";
import { DurableObject } from "cloudflare:workers";
import { platformSigner } from "../signing.js";
import { AUDIT_LOG_NAME } from "./audit.js";
import {
  AuditAppendInput,
  buildEntry,
  type ChainLink,
  type ChainVerification,
  verifyEntries,
} from "./chain.js";

const MIRROR_BATCH = 50;
const MIRROR_RETRY_MS = 30_000;

type EventRow = {
  seq: number;
  at: string;
  principal_id: string;
  action: string;
  subject: string;
  payload_hash: string;
  prev_hash: string;
  hash: string;
  signature: string;
  key_id: string;
  payload: string | null;
  mirrored: number;
};

function toEvent(r: EventRow): AuditEvent {
  return {
    seq: r.seq,
    at: r.at,
    principalId: r.principal_id,
    action: r.action,
    subject: r.subject,
    payloadHash: r.payload_hash,
    prevHash: r.prev_hash,
    hash: r.hash,
    signature: r.signature,
    keyId: r.key_id,
  };
}

function parsePayload(text: string | null): unknown {
  return text === null ? null : (JSON.parse(text) as unknown);
}

export class AuditLog extends DurableObject<Env> {
  /** Instance name ("global"); keys this log's rows in the D1 mirror. */
  private get logName(): string {
    return this.ctx.id.name ?? AUDIT_LOG_NAME;
  }

  /** Serializes appends: read head → build + sign → write happens without interleaving. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      action TEXT NOT NULL,
      subject TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      signature TEXT NOT NULL,
      key_id TEXT NOT NULL,
      payload TEXT,
      mirrored INTEGER NOT NULL DEFAULT 0
    )`);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS events_unmirrored ON events (mirrored, seq)");
  }

  /** Append one signed, chained entry and mirror it to D1. */
  async append(input: AuditAppendInput): Promise<AuditEvent> {
    const parsed = AuditAppendInput.parse(input);
    const run = this.tail.then(() => this.appendNow(parsed));
    this.tail = run.catch(() => undefined);
    const event = await run;
    await this.flushMirror();
    return event;
  }

  private async appendNow(input: AuditAppendInput): Promise<AuditEvent> {
    const signer = await platformSigner(this.env);
    const event = await buildEntry(this.head(), input, new Date(), signer);
    this.ctx.storage.sql.exec(
      `INSERT INTO events (seq, at, principal_id, action, subject, payload_hash, prev_hash, hash, signature, key_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.seq,
      event.at,
      event.principalId,
      event.action,
      event.subject,
      event.payloadHash,
      event.prevHash,
      event.hash,
      event.signature,
      event.keyId,
      JSON.stringify(input.payload ?? null),
    );
    return event;
  }

  private head(): ChainLink | null {
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; hash: string }>("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1")
      .toArray();
    return rows[0] ?? null;
  }

  async headLink(): Promise<ChainLink | null> {
    return this.head();
  }

  /** Entries with seq > afterSeq, ascending. */
  async list(afterSeq = 0, limit = 100): Promise<AuditEvent[]> {
    return this.ctx.storage.sql
      .exec<EventRow>("SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?", afterSeq, limit)
      .toArray()
      .map(toEvent);
  }

  /**
   * Re-verify the chain from `fromSeq` (default: genesis): links, entry hashes, payload hashes
   * and signatures. Starting later trusts the entry before `fromSeq` as the anchor.
   */
  async verifyChain(fromSeq = 1): Promise<ChainVerification> {
    const signer = await platformSigner(this.env);
    const start = Math.max(1, Math.floor(fromSeq));
    let anchor: ChainLink | null = null;
    if (start > 1) {
      const a = this.ctx.storage.sql
        .exec<{ seq: number; hash: string }>("SELECT seq, hash FROM events WHERE seq = ?", start - 1)
        .toArray()[0];
      if (!a) return { verified: false, brokenAt: start - 1, reason: "anchor entry missing", checked: 0, headSeq: 0 };
      anchor = a;
    }
    const rows = this.ctx.storage.sql
      .exec<EventRow>("SELECT * FROM events WHERE seq >= ? ORDER BY seq ASC", start)
      .toArray();
    const payloads = new Map<number, unknown>();
    for (const r of rows) {
      try {
        payloads.set(r.seq, parsePayload(r.payload));
      } catch {
        return { verified: false, brokenAt: r.seq, reason: "payload is not JSON", checked: 0, headSeq: 0 };
      }
    }
    return verifyEntries(rows.map(toEvent), signer, { anchor, payloads });
  }

  /** Copy unmirrored entries to D1 (idempotent: INSERT OR IGNORE by seq). */
  async flushMirror(): Promise<number> {
    const pending = this.ctx.storage.sql
      .exec<EventRow>("SELECT * FROM events WHERE mirrored = 0 ORDER BY seq ASC")
      .toArray();
    let done = 0;
    try {
      for (let i = 0; i < pending.length; i += MIRROR_BATCH) {
        const chunk = pending.slice(i, i + MIRROR_BATCH);
        await this.env.DB.batch(
          chunk.map((r) =>
            this.env.DB.prepare(
              `INSERT OR IGNORE INTO audit_events
                 (log, seq, at, principal_id, action, subject, payload_hash, prev_hash, hash, signature, key_id, payload)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              this.logName,
              r.seq,
              r.at,
              r.principal_id,
              r.action,
              r.subject,
              r.payload_hash,
              r.prev_hash,
              r.hash,
              r.signature,
              r.key_id,
              r.payload,
            ),
          ),
        );
        const last = chunk[chunk.length - 1];
        if (last) this.ctx.storage.sql.exec("UPDATE events SET mirrored = 1 WHERE mirrored = 0 AND seq <= ?", last.seq);
        done += chunk.length;
      }
    } catch (e) {
      console.error("audit mirror to D1 failed; retrying by alarm", e);
      await this.ctx.storage.setAlarm(Date.now() + MIRROR_RETRY_MS);
    }
    return done;
  }

  override async alarm(): Promise<void> {
    await this.flushMirror();
  }
}
