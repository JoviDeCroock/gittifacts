/**
 * AuditLog Durable Object: the single writer of the append-only, hash-chained, signed audit log.
 * One instance per org (the platform uses the name "global" for now).
 *
 * Source of truth is this DO's SQLite storage. Every entry is mirrored to D1 `audit_events` for
 * queries; a failed mirror write is retried on the next append and by an alarm, so the mirror is
 * eventually complete and never reordered (rows are keyed by seq).
 */

import { DurableObject } from "cloudflare:workers";
import type { AuditEvent } from "@app/domain";
import { toWellFormedJson } from "@app/evidence";
import { platformSigner } from "../signing.js";
import { AUDIT_LOG_NAME } from "./audit.js";
import {
  AuditAppendInput,
  buildEntry,
  type ChainLink,
  type ChainVerification,
  type LogVerification,
  verifyEntries,
} from "./chain.js";

const MIRROR_BATCH = 50;
const MIRROR_RETRY_MS = 30_000;
/** Most new entries one read verifies (Ed25519 each); the rest wait for the next read. */
export const VERIFY_BATCH = 200;
/** Rows per batch of a full re-verify. */
const FULL_BATCH = 500;

type VerifyState = {
  throughSeq: number;
  throughHash: string;
  brokenAt: number | null;
  reason: string | null;
  fullAt: string | null;
};

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
    // Verified-through checkpoint and any recorded break (M9): one row, id = 1.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS verify_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      through_seq INTEGER NOT NULL,
      through_hash TEXT NOT NULL,
      broken_at INTEGER,
      broken_reason TEXT,
      full_at TEXT
    )`);
  }

  /**
   * Append one signed, chained entry and mirror it to D1.
   *
   * Strings are made well-formed first (lone UTF-16 surrogates become U+FFFD): canonical JSON
   * rejects lone surrogates, and an append that throws after its state change committed would leave
   * that change unaudited (security audit M10). The entry records the text as D1 stores it.
   */
  async append(input: AuditAppendInput): Promise<AuditEvent> {
    const parsed = AuditAppendInput.parse(toWellFormedJson(input));
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
      .exec<EventRow>(
        "SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?",
        afterSeq,
        limit,
      )
      .toArray()
      .map(toEvent);
  }

  /**
   * Verify the chain incrementally (security audit M9): from the verified-through checkpoint, at
   * most `limit` new entries per call, advancing the checkpoint. The checkpoint entry itself is
   * re-checked every time (still present, same hash, valid hash, payload and signature), so
   * rewriting the entry the checkpoint names is caught; entries before it are covered by
   * {@link verifyChainFull}. A break, once found, is recorded and reported until a full re-verify
   * passes.
   */
  async verifyChain(opts: { limit?: number } = {}): Promise<LogVerification> {
    const limit = Math.max(1, Math.min(VERIFY_BATCH, Math.floor(opts.limit ?? VERIFY_BATCH)));
    const state = this.verifyState();
    const headSeq = this.head()?.seq ?? 0;
    if (state.brokenAt !== null) return this.verdict(headSeq, 0);
    const r =
      state.throughSeq > 0
        ? await this.verifyRange(state.throughSeq, limit + 1, null, state.throughHash)
        : await this.verifyRange(1, limit, null);
    if (r.last && r.last.seq > state.throughSeq) this.saveThrough(r.last);
    if (!r.verified) this.recordBreak(r.brokenAt ?? state.throughSeq + 1, r.reason);
    return this.verdict(headSeq, r.checked);
  }

  /**
   * Full re-verify from genesis, ignoring the checkpoint (platform admins: POST
   * /api/v1/admin/audit/verify). Reads in batches; O(N) signature checks, so never on a read path.
   * A pass clears a recorded break and moves the checkpoint to the head.
   */
  async verifyChainFull(): Promise<LogVerification> {
    const headSeq = this.head()?.seq ?? 0;
    let checked = 0;
    let anchor: ChainLink | null = null;
    for (;;) {
      const r = await this.verifyRange(anchor ? anchor.seq + 1 : 1, FULL_BATCH, anchor);
      checked += r.checked;
      if (!r.verified) {
        this.ctx.storage.sql.exec("DELETE FROM verify_state");
        if (anchor ?? r.last) this.saveThrough((r.last ?? anchor) as ChainLink);
        this.recordBreak(r.brokenAt ?? 1, r.reason);
        return this.verdict(headSeq, checked);
      }
      if (r.last) anchor = r.last;
      if (r.checked < FULL_BATCH) break;
    }
    this.ctx.storage.sql.exec("DELETE FROM verify_state");
    this.saveThrough(anchor ?? { seq: 0, hash: "" });
    this.ctx.storage.sql.exec("UPDATE verify_state SET full_at = ?", new Date().toISOString());
    return this.verdict(headSeq, checked);
  }

  private verifyState(): VerifyState {
    const row = this.ctx.storage.sql
      .exec<{
        through_seq: number;
        through_hash: string;
        broken_at: number | null;
        broken_reason: string | null;
        full_at: string | null;
      }>("SELECT * FROM verify_state WHERE id = 1")
      .toArray()[0];
    return {
      throughSeq: row?.through_seq ?? 0,
      throughHash: row?.through_hash ?? "",
      brokenAt: row?.broken_at ?? null,
      reason: row?.broken_reason ?? null,
      fullAt: row?.full_at ?? null,
    };
  }

  private saveThrough(link: ChainLink): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO verify_state (id, through_seq, through_hash) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET through_seq = excluded.through_seq, through_hash = excluded.through_hash`,
      link.seq,
      link.hash,
    );
  }

  private recordBreak(brokenAt: number, reason: string | undefined): void {
    console.error(`audit chain broken at seq ${brokenAt}: ${reason ?? "unknown"}`);
    this.ctx.storage.sql.exec(
      `INSERT INTO verify_state (id, through_seq, through_hash, broken_at, broken_reason) VALUES (1, 0, '', ?, ?)
       ON CONFLICT (id) DO UPDATE SET broken_at = excluded.broken_at, broken_reason = excluded.broken_reason`,
      brokenAt,
      reason ?? null,
    );
  }

  private verdict(headSeq: number, checked: number): LogVerification {
    const s = this.verifyState();
    const complete = s.throughSeq >= headSeq;
    const base = { checked, headSeq, verifiedThrough: s.throughSeq, complete, fullAt: s.fullAt };
    if (s.brokenAt !== null)
      return { ...base, verified: false, brokenAt: s.brokenAt, reason: s.reason ?? "chain broken" };
    return { ...base, verified: complete };
  }

  /**
   * Verify up to `limit` contiguous entries from `from`. With no `anchor` and from > 1, the first
   * entry's own prevHash stands in for its link (it re-checks a checkpoint entry, whose link was
   * verified when the checkpoint advanced past it) and its hash must equal `expectHash`.
   */
  private async verifyRange(
    from: number,
    limit: number,
    anchor: ChainLink | null,
    expectHash?: string,
  ): Promise<ChainVerification & { last: ChainLink | null }> {
    const broken = (seq: number, reason: string) => ({
      verified: false,
      brokenAt: seq,
      reason,
      checked: 0,
      headSeq: 0,
      last: null,
    });
    const rows = this.ctx.storage.sql
      .exec<EventRow>("SELECT * FROM events WHERE seq >= ? ORDER BY seq ASC LIMIT ?", from, limit)
      .toArray();
    const first = rows[0];
    if (from > 1 && anchor === null) {
      if (!first || first.seq !== from) return broken(from, "checkpoint entry missing");
      if (expectHash !== undefined && first.hash !== expectHash)
        return broken(from, "checkpoint entry changed since it was verified");
    }
    const payloads = new Map<number, unknown>();
    for (const r of rows) {
      try {
        payloads.set(r.seq, parsePayload(r.payload));
      } catch {
        return broken(r.seq, "payload is not JSON");
      }
    }
    const link =
      anchor ?? (first && from > 1 ? { seq: first.seq - 1, hash: first.prev_hash } : null);
    const signer = await platformSigner(this.env);
    const r = await verifyEntries(rows.map(toEvent), signer, { anchor: link, payloads });
    const lastSeq = r.verified ? rows[rows.length - 1]?.seq : (r.brokenAt ?? from) - 1;
    const lastRow = rows.find((x) => x.seq === lastSeq);
    return { ...r, last: lastRow ? { seq: lastRow.seq, hash: lastRow.hash } : null };
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
        if (last)
          this.ctx.storage.sql.exec(
            "UPDATE events SET mirrored = 1 WHERE mirrored = 0 AND seq <= ?",
            last.seq,
          );
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
