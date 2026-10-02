/**
 * The DO loop of `packages/merge-queue/src/shell.ts`, node-safe:
 *
 *   zod-validate the event → `step(state, event, { now })` → persist state + command outbox + §5
 *   events in ONE transaction → execute the outbox (idempotent handlers, retried with backoff) →
 *   handlers feed their results back through `dispatch`, which deletes the command in the same
 *   transaction that applies its result.
 *
 * `dispatch` is synchronous (no awaits between reading and writing the state), so in a Durable
 * Object no other event can interleave with a step. `InvariantViolation` → persist nothing,
 * record the halt, alert, and stop processing until an operator resumes the queue.
 * The deploy trains run the same way (`dispatchTrain`, `trainStep`) in the same store.
 */
import {
  type Command,
  CoreEvent,
  initialState,
  queueConfig,
  type CoreEventInput,
  InvariantViolation,
  type QueueState,
  step,
  type TrainCommand,
  TrainEvent,
  type TrainEventInput,
  type TrainState,
  trainStep,
} from "@app/merge-queue";
import type { EventRow, OutboxRow, QueueStore } from "./store.js";

export interface HaltInfo {
  code: string;
  message: string;
  at: number;
  event: string;
  details: Record<string, unknown>;
}

export class QueueHaltedError extends Error {
  override readonly name = "QueueHaltedError";
  constructor(readonly halt: HaltInfo) {
    super(`merge queue halted: [${halt.code}] ${halt.message}`);
  }
}

export class InvalidQueueEventError extends Error {
  override readonly name = "InvalidQueueEventError";
}

export type CoreEmit = (event: CoreEventInput) => Promise<void>;
export type TrainEmit = (event: TrainEventInput) => Promise<void>;

export interface LoopHandlers {
  core(cmd: Command, emit: CoreEmit, row: OutboxRow): Promise<void>;
  train(cmd: TrainCommand, emit: TrainEmit, row: OutboxRow): Promise<void>;
  /**
   * A command failed `maxAttempts` times. Return the result event the protocol allows for it
   * (e.g. an errored BatchResult), or null to drop it (the core's own timeouts recover).
   */
  giveUp(cmd: Command, error: string): CoreEventInput | null;
  /** New §5 events were committed (wake long-polls and SSE). */
  onEvents(rows: EventRow[]): void;
  /** The core refused a step (InvariantViolation): alert. Never throws. */
  onHalt(halt: HaltInfo): Promise<void>;
  /** A command failed for good (audited by the caller). */
  onDropped(row: OutboxRow, error: string): Promise<void>;
}

export interface LoopOptions {
  now(): number;
  /** Initial state when the store has none (first event of a new queue). */
  initialState(): QueueState;
  initialTrains(): TrainState;
  maxConcurrent?: number;
  maxAttempts?: number;
  /** Backoff after the n-th failure (default 5 s · 2^n, capped at 5 min). */
  backoffMs?(attempt: number): number;
}

export type DispatchResult = { seqs: number[]; commands: number };

/**
 * A state persisted by an older core: fields added since get their initial values and the config
 * its new defaults (the core's state shape grows; persisted DOs must keep loading).
 */
export function upgradeState(loaded: QueueState): QueueState {
  const config = queueConfig(loaded.config);
  return { ...initialState(loaded.main.sha, config, 0), ...loaded, config };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class QueueLoop {
  private coreState: QueueState | null = null;
  private trainState: TrainState | null = null;
  private readonly running = new Set<number>();
  private again = false;

  constructor(
    private readonly store: QueueStore,
    private readonly handlers: LoopHandlers,
    private readonly opts: LoopOptions,
  ) {}

  /** The persisted core state (created on first use; older shapes get new fields' defaults). */
  get state(): QueueState {
    if (this.coreState === null) {
      const loaded = this.store.loadState();
      this.coreState = loaded === null ? this.opts.initialState() : upgradeState(loaded);
    }
    return this.coreState;
  }

  get trains(): TrainState {
    this.trainState ??= this.store.loadTrains() ?? this.opts.initialTrains();
    return this.trainState;
  }

  get halted(): HaltInfo | null {
    return this.store.getMeta<HaltInfo>("halted");
  }

  /** Operator action after a halt: forget it and continue from the last persisted state. */
  resume(): void {
    this.store.setMeta("halted", null);
    this.coreState = null;
    this.kick();
  }

  // ------------------------------------------------------------ dispatch

  /** Validate and apply one core event. Throws on invalid input or when the queue is halted. */
  dispatch(raw: unknown, done: number | null = null): DispatchResult {
    const halt = this.halted;
    if (halt !== null) throw new QueueHaltedError(halt);
    const parsed = CoreEvent.safeParse(raw);
    if (!parsed.success) {
      throw new InvalidQueueEventError(
        `invalid queue event: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const now = this.opts.now();
    let next: { state: QueueState; commands: Command[] };
    try {
      next = step(this.state, parsed.data, { now });
    } catch (e) {
      if (e instanceof InvariantViolation) this.haltOn(e, parsed.data.type, now);
      throw e;
    }
    return this.persist({ state: next.state, commands: next.commands, lane: "core", done, now });
  }

  /** Validate and apply one deploy-train event. */
  dispatchTrain(raw: unknown, done: number | null = null): DispatchResult {
    const halt = this.halted;
    if (halt !== null) throw new QueueHaltedError(halt);
    const parsed = TrainEvent.safeParse(raw);
    if (!parsed.success)
      throw new InvalidQueueEventError(`invalid train event: ${parsed.error.issues[0]?.message}`);
    const now = this.opts.now();
    const next = trainStep(this.trains, parsed.data, { now });
    return this.persist({
      trains: next.state,
      commands: next.commands,
      lane: "train",
      done,
      now,
    });
  }

  private persist(input: {
    state?: QueueState;
    trains?: TrainState;
    commands: (Command | TrainCommand)[];
    lane: "core" | "train";
    done: number | null;
    now: number;
  }): DispatchResult {
    const events = input.commands.flatMap((c) =>
      c.type === "Emit"
        ? [
            {
              at: c.event.at,
              changeId: "changeId" in c.event ? c.event.changeId : null,
              type: c.event.type,
              data: c.event,
            },
          ]
        : [],
    );
    const { eventSeqs } = this.store.commit({
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.trains === undefined ? {} : { trains: input.trains }),
      commands: input.commands.map((command) => ({ lane: input.lane, command })),
      events,
      done: input.done,
      now: input.now,
    });
    if (input.state !== undefined) this.coreState = input.state;
    if (input.trains !== undefined) this.trainState = input.trains;
    if (eventSeqs.length > 0) {
      const first = (eventSeqs[0] ?? 1) - 1;
      this.handlers.onEvents(this.store.eventsSince(first, eventSeqs.length));
    }
    if (input.commands.length > 0) this.kick();
    return { seqs: eventSeqs, commands: input.commands.length };
  }

  private haltOn(e: InvariantViolation, event: string, now: number): void {
    const halt: HaltInfo = { code: e.code, message: e.message, at: now, event, details: e.details };
    this.store.setMeta("halted", halt);
    void this.handlers.onHalt(halt).catch(() => undefined);
  }

  // ------------------------------------------------------------ the outbox

  private readonly inflight = new Map<number, Promise<void>>();
  private inDrain = false;

  /** Start due commands now (never awaits them: callers stay synchronous). */
  kick(): void {
    if (this.inDrain) {
      this.again = true;
      return;
    }
    this.inDrain = true;
    try {
      do {
        this.again = false;
        this.startDue();
      } while (this.again);
    } finally {
      this.inDrain = false;
    }
  }

  private startDue(): void {
    const max = this.opts.maxConcurrent ?? 16;
    if (this.halted !== null || this.running.size >= max) return;
    for (const row of this.store.dueCommands(this.opts.now(), max * 4)) {
      if (this.running.size >= max) break;
      if (this.running.has(row.id)) continue;
      this.running.add(row.id);
      const p = this.execute(row).finally(() => {
        this.running.delete(row.id);
        this.inflight.delete(row.id);
        this.kick();
      });
      this.inflight.set(row.id, p);
    }
  }

  /** Wait until no command is running or due (tests, and the end of an alarm). */
  async settle(maxRounds = 10_000): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      this.kick();
      if (this.inflight.size === 0) return;
      await Promise.allSettled([...this.inflight.values()]);
    }
  }

  private async execute(row: OutboxRow): Promise<void> {
    try {
      if (row.lane === "train") {
        await this.handlers.train(
          row.command as TrainCommand,
          async (e) => void this.dispatchTrain(e, row.id),
          row,
        );
      } else {
        await this.handlers.core(
          row.command as Command,
          async (e) => void this.dispatch(e, row.id),
          row,
        );
      }
      this.store.deleteCommand(row.id);
    } catch (e) {
      if (e instanceof QueueHaltedError || e instanceof InvariantViolation) return;
      const message = errorText(e);
      const attempts = row.attempts + 1;
      if (attempts < (this.opts.maxAttempts ?? 6)) {
        const delay = this.opts.backoffMs?.(attempts) ?? Math.min(300_000, 5_000 * 2 ** attempts);
        this.store.retryCommand(row.id, this.opts.now() + delay, message);
        return;
      }
      await this.giveUp(row, message);
    }
  }

  private async giveUp(row: OutboxRow, message: string): Promise<void> {
    const result =
      row.lane === "core" ? this.handlers.giveUp(row.command as Command, message) : null;
    try {
      if (result !== null) this.dispatch(result, row.id);
    } catch {
      // The synthesized result no longer applies (state moved on): drop the command anyway.
    }
    this.store.deleteCommand(row.id);
    await this.handlers.onDropped(row, message).catch(() => undefined);
  }

  /** When the DO alarm should fire next (null: nothing pending). */
  nextCommandAt(): number | null {
    return this.store.nextCommandAt();
  }

  get busy(): number {
    return this.running.size;
  }
}
