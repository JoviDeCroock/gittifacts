/**
 * Durable state of one repo's merge queue, in the `MergeQueue` Durable Object's SQLite.
 *
 * - `mq_blob`: the pure core's `QueueState` and the deploy trains' `TrainState`, as JSON split
 *   into chunks (DO SQLite caps a value at 2 MB).
 * - `mq_outbox`: commands the core issued and the shell has not finished yet. A step's state and
 *   its commands are written in ONE transaction (`commit`), so a crash never loses a command or
 *   runs one for a state that was never persisted.
 * - `mq_events`: the §5 agent-facing events (SSE, `wait_for_merge`), trimmed to the newest rows.
 * - `mq_heads`: where each enqueued head lives and what to replay it from (resolved heads live in
 *   the queue's scratch repo and replay from the commit the resolution was built on).
 * - `mq_intents`: enqueue options from MCP/HTTP (`enqueue`) and the ChangeWorkflow registration.
 * - `mq_commits`: commit → Change, so conflicts can name the upstream Change (best effort).
 * - `mq_idem`, `mq_runs`, `mq_meta`: idempotency keys, batch-run outputs, small values.
 *
 * Node-safe: everything goes through `SqlLike` (DO `ctx.storage.sql`, or node:sqlite in tests).
 */
import type { QueueState, TrainState } from "@app/merge-queue";
import type { SqlLike } from "../merge-queue.js";

export type { SqlLike };

/** Runs `fn` atomically (DO: `ctx.storage.transactionSync`). */
export type Transact = <T>(fn: () => T) => T;

/** A command waiting in the outbox. `lane` = which machine issued it. */
export interface OutboxRow {
  id: number;
  lane: "core" | "train";
  command: unknown;
  attempts: number;
  nextAt: number;
  lastError: string | null;
}

export interface EventRow {
  seq: number;
  at: number;
  changeId: string | null;
  type: string;
  data: unknown;
}

export interface HeadInfo {
  /** The commit the head's own work is replayed from (merge-attempt `--base`). */
  replayBase: string;
  /** The Artifacts repo holding the head (the Change's fork, or the queue scratch repo). */
  repo: string;
}

const CHUNK = 900_000;
const EVENTS_KEPT = 5000;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS mq_blob (name TEXT NOT NULL, chunk INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (name, chunk))",
  "CREATE TABLE IF NOT EXISTS mq_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, lane TEXT NOT NULL, command TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT)",
  "CREATE TABLE IF NOT EXISTS mq_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, change_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS mq_events_change ON mq_events (change_id, seq)",
  "CREATE TABLE IF NOT EXISTS mq_heads (change_id TEXT NOT NULL, head_sha TEXT NOT NULL, replay_base TEXT NOT NULL, repo TEXT NOT NULL, PRIMARY KEY (change_id, head_sha))",
  "CREATE TABLE IF NOT EXISTS mq_intents (change_id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS mq_commits (sha TEXT PRIMARY KEY, change_id TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS mq_idem (key TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS mq_runs (run_id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS mq_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
];

function json(v: unknown): string {
  return JSON.stringify(v);
}

export class QueueStore {
  constructor(
    private readonly sql: SqlLike,
    readonly transact: Transact,
  ) {
    for (const q of SCHEMA) sql.exec(q);
  }

  private rows(query: string, ...b: (string | number | null)[]): Record<string, unknown>[] {
    return this.sql.exec(query, ...b).toArray();
  }

  // ------------------------------------------------------------ blobs (core + train state)

  private readBlob<T>(name: string): T | null {
    const rows = this.rows("SELECT data FROM mq_blob WHERE name = ? ORDER BY chunk ASC", name);
    if (rows.length === 0) return null;
    return JSON.parse(rows.map((r) => String(r.data)).join("")) as T;
  }

  private writeBlob(name: string, value: unknown): void {
    const text = json(value);
    let n = 0;
    for (let i = 0; i < text.length || n === 0; i += CHUNK, n++) {
      this.sql.exec(
        "INSERT INTO mq_blob (name, chunk, data) VALUES (?, ?, ?) ON CONFLICT(name, chunk) DO UPDATE SET data = excluded.data",
        name,
        n,
        text.slice(i, i + CHUNK),
      );
    }
    this.sql.exec("DELETE FROM mq_blob WHERE name = ? AND chunk >= ?", name, n);
  }

  loadState(): QueueState | null {
    return this.readBlob<QueueState>("core");
  }

  loadTrains(): TrainState | null {
    return this.readBlob<TrainState>("trains");
  }

  /**
   * One step, atomically: the new machine state(s), the commands to run, the §5 events, and
   * (when the step consumed a command's result) the command that produced it.
   */
  commit(input: {
    state?: QueueState;
    trains?: TrainState;
    commands?: { lane: "core" | "train"; command: unknown }[];
    events?: { at: number; changeId: string | null; type: string; data: unknown }[];
    done?: number | null;
    now: number;
  }): { commandIds: number[]; eventSeqs: number[] } {
    return this.transact(() => {
      if (input.state !== undefined) this.writeBlob("core", input.state);
      if (input.trains !== undefined) this.writeBlob("trains", input.trains);
      const commandIds: number[] = [];
      for (const c of input.commands ?? []) {
        const row = this.rows(
          "INSERT INTO mq_outbox (lane, command, attempts, next_at) VALUES (?, ?, 0, ?) RETURNING id",
          c.lane,
          json(c.command),
          input.now,
        )[0];
        commandIds.push(Number(row?.id));
      }
      const eventSeqs: number[] = [];
      for (const e of input.events ?? []) {
        const row = this.rows(
          "INSERT INTO mq_events (at, change_id, type, data) VALUES (?, ?, ?, ?) RETURNING seq",
          e.at,
          e.changeId,
          e.type,
          json(e.data),
        )[0];
        eventSeqs.push(Number(row?.seq));
      }
      if (eventSeqs.length > 0) {
        const last = eventSeqs[eventSeqs.length - 1] ?? 0;
        this.sql.exec("DELETE FROM mq_events WHERE seq <= ?", last - EVENTS_KEPT);
      }
      if (input.done !== undefined && input.done !== null)
        this.sql.exec("DELETE FROM mq_outbox WHERE id = ?", input.done);
      return { commandIds, eventSeqs };
    });
  }

  // ------------------------------------------------------------ outbox

  private toOutbox(r: Record<string, unknown>): OutboxRow {
    return {
      id: Number(r.id),
      lane: r.lane === "train" ? "train" : "core",
      command: JSON.parse(String(r.command)) as unknown,
      attempts: Number(r.attempts),
      nextAt: Number(r.next_at),
      lastError: r.last_error === null || r.last_error === undefined ? null : String(r.last_error),
    };
  }

  /** Commands due at `now`, oldest first. */
  dueCommands(now: number, limit: number): OutboxRow[] {
    return this.rows(
      "SELECT * FROM mq_outbox WHERE next_at <= ? ORDER BY id ASC LIMIT ?",
      now,
      limit,
    ).map((r) => this.toOutbox(r));
  }

  command(id: number): OutboxRow | null {
    const r = this.rows("SELECT * FROM mq_outbox WHERE id = ?", id)[0];
    return r === undefined ? null : this.toOutbox(r);
  }

  pendingCommands(): number {
    return Number(this.rows("SELECT COUNT(*) AS n FROM mq_outbox")[0]?.n ?? 0);
  }

  /** Earliest `next_at` of any command (null: outbox empty). */
  nextCommandAt(): number | null {
    const v = this.rows("SELECT MIN(next_at) AS t FROM mq_outbox")[0]?.t;
    return v === null || v === undefined ? null : Number(v);
  }

  retryCommand(id: number, nextAt: number, error: string): void {
    this.sql.exec(
      "UPDATE mq_outbox SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE id = ?",
      nextAt,
      error.slice(0, 2000),
      id,
    );
  }

  deleteCommand(id: number): void {
    this.sql.exec("DELETE FROM mq_outbox WHERE id = ?", id);
  }

  // ------------------------------------------------------------ events

  eventsSince(since: number, limit: number, changeId?: string): EventRow[] {
    const rows =
      changeId === undefined
        ? this.rows("SELECT * FROM mq_events WHERE seq > ? ORDER BY seq ASC LIMIT ?", since, limit)
        : this.rows(
            "SELECT * FROM mq_events WHERE seq > ? AND change_id = ? ORDER BY seq ASC LIMIT ?",
            since,
            changeId,
            limit,
          );
    return rows.map((r) => ({
      seq: Number(r.seq),
      at: Number(r.at),
      changeId: r.change_id === null ? null : String(r.change_id),
      type: String(r.type),
      data: JSON.parse(String(r.data)) as unknown,
    }));
  }

  lastEventSeq(): number {
    return Number(this.rows("SELECT MAX(seq) AS s FROM mq_events")[0]?.s ?? 0);
  }

  // ------------------------------------------------------------ heads, commits, intents

  putHead(changeId: string, headSha: string, info: HeadInfo): void {
    this.sql.exec(
      "INSERT INTO mq_heads (change_id, head_sha, replay_base, repo) VALUES (?, ?, ?, ?) ON CONFLICT(change_id, head_sha) DO UPDATE SET replay_base = excluded.replay_base, repo = excluded.repo",
      changeId,
      headSha,
      info.replayBase,
      info.repo,
    );
  }

  getHead(changeId: string, headSha: string): HeadInfo | null {
    const r = this.rows(
      "SELECT replay_base, repo FROM mq_heads WHERE change_id = ? AND head_sha = ?",
      changeId,
      headSha,
    )[0];
    return r === undefined ? null : { replayBase: String(r.replay_base), repo: String(r.repo) };
  }

  putCommits(commits: { sha: string; changeId: string }[]): void {
    for (const c of commits)
      this.sql.exec(
        "INSERT INTO mq_commits (sha, change_id) VALUES (?, ?) ON CONFLICT(sha) DO NOTHING",
        c.sha,
        c.changeId,
      );
  }

  changeOfCommit(sha: string): string | null {
    const r = this.rows("SELECT change_id FROM mq_commits WHERE sha = ?", sha)[0];
    return r === undefined ? null : String(r.change_id);
  }

  getIntent<T>(changeId: string): T | null {
    const r = this.rows("SELECT data FROM mq_intents WHERE change_id = ?", changeId)[0];
    return r === undefined ? null : (JSON.parse(String(r.data)) as T);
  }

  putIntent(changeId: string, intent: unknown): void {
    this.sql.exec(
      "INSERT INTO mq_intents (change_id, data) VALUES (?, ?) ON CONFLICT(change_id) DO UPDATE SET data = excluded.data",
      changeId,
      json(intent),
    );
  }

  // ------------------------------------------------------------ idempotency, runs, meta

  getIdem<T>(key: string, notBefore: number): T | null {
    const r = this.rows("SELECT data FROM mq_idem WHERE key = ? AND at >= ?", key, notBefore)[0];
    return r === undefined ? null : (JSON.parse(String(r.data)) as T);
  }

  putIdem(key: string, at: number, value: unknown): void {
    this.sql.exec(
      "INSERT INTO mq_idem (key, at, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, data = excluded.data",
      key,
      at,
      json(value),
    );
    this.sql.exec("DELETE FROM mq_idem WHERE at < ?", at - 24 * 3_600_000);
  }

  putRun(runId: string, data: unknown): void {
    this.sql.exec(
      "INSERT INTO mq_runs (run_id, data) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET data = excluded.data",
      runId,
      json(data),
    );
  }

  getRun<T>(runId: string): T | null {
    const r = this.rows("SELECT data FROM mq_runs WHERE run_id = ?", runId)[0];
    return r === undefined ? null : (JSON.parse(String(r.data)) as T);
  }

  getMeta<T>(k: string): T | null {
    const r = this.rows("SELECT v FROM mq_meta WHERE k = ?", k)[0];
    return r === undefined ? null : (JSON.parse(String(r.v)) as T);
  }

  setMeta(k: string, v: unknown): void {
    if (v === null) {
      this.sql.exec("DELETE FROM mq_meta WHERE k = ?", k);
      return;
    }
    this.sql.exec(
      "INSERT INTO mq_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      json(v),
    );
  }
}
