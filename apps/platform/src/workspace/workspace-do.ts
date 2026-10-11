/**
 * `Workspace`: one Durable Object per Change workspace (`ws-<changeId>`), driving one container
 * through `ctx.container` (sandbox image, `scheduling_policy: "durable_object"`).
 *
 * Lifecycle:
 * - **open** starts a container from the newest thing it can: its own sleep snapshot, else the
 *   Change's CI dependency snapshot (install step), else the image; then (unless resuming from
 *   its sleep snapshot) checks out the Change's fork at its head on its branch, with a short-lived
 *   read token for that fork in the checkout exec's env only.
 * - **idle** for `idleMs` (no tool call) → snapshot the root filesystem, stop the container
 *   ("sleeping"); the next call resumes from the snapshot. `setInactivityTimeout` is the backstop.
 * - **hard TTL** (`expiresAt`, from open) → stop, drop the snapshot, "expired". `close` does the
 *   same on request ("closed").
 * - Usage (container seconds × vCPUs) goes to the project's `ProjectLedger`.
 *
 * Safety: the record only ever names a `task-*` fork (OpenSpec), every RPC is checked against the
 * principal that opened it, tokens are minted per exec through the platform's default-role
 * GitHost (fork-only write guard) and never stored, and the push goes to the fork's branch, so
 * the normal push flow (CI → evidence → lane → tour) decides what happens next.
 */

import { DurableObject } from "cloudflare:workers";
import { REGISTRY_HOSTS } from "@app/ci-engine";
import { isForkName, resolveRuntime, SYSTEM_PRINCIPAL_ID } from "@app/coordinator";
import { DoAudit } from "../audit/audit.js";
import { addPlanUsage, type PlanGateEnv, WORKSPACE_CPU_SECONDS } from "../limits/plan-gate.js";
import { recordSpend, type SpendEnv } from "../spend/meter.js";
import { containerUsd } from "../spend/prices.js";
import {
  type BootFrom,
  type CommitPushOutcome,
  ContainerMachine,
  type DiffOutcome,
  type ExecOutcome,
  MachineError,
  WORKSPACE_EGRESS_EXPORT,
  type WorkspaceMachine,
} from "./machine.js";
import {
  checkWorkspacePath,
  INSTANCE_VCPU,
  OpenSpec,
  type RestoredFrom,
  type WorkspaceErrorBody,
  WorkspaceRecord,
  type WorkspaceResult,
  type WorkspaceStatus,
} from "./model.js";
import { workspaceRuntime } from "./runtime.js";

/** What the DO reports about itself (the service adds the project's remaining quota). */
export interface WorkspaceViewData {
  workspaceId: string;
  changeId: string;
  repoId: string;
  forkName: string;
  branch: string;
  baseSha: string;
  headSha: string | null;
  status: WorkspaceStatus;
  network: "open" | "registries-only";
  expiresAt: string;
  idleSleepSec: number;
  restoredFrom: RestoredFrom | null;
  containerSeconds: number;
  lastError: string | null;
  egressDenied: number;
}

export interface WsReadData {
  path: string;
  content: string;
  binary: boolean;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

export interface WsWriteData {
  path: string;
  mode: "content" | "patch";
  bytes: number;
  created: boolean;
}

/** Bytes `ws_read` returns at most (larger files are truncated). */
export const MAX_READ_BYTES = 256 * 1024;
export const MAX_DIFF_BYTES = 256 * 1024;
const TOKEN_TTL_SEC = 600;
const ACTIVE: readonly WorkspaceStatus[] = ["starting", "ready", "sleeping"];

/** Bindings the DO reads (a subset of the Worker's `Env`). */
interface WorkspaceEnv {
  PROJECT_LEDGER: Pick<DurableObjectNamespace, "getByName">;
}

function err(
  code: WorkspaceErrorBody["code"],
  message: string,
  fix: WorkspaceErrorBody["fix"],
): { ok: false; error: WorkspaceErrorBody } {
  return { ok: false, error: { code, message, fix } };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type LedgerStub = {
  recordUsage(input: {
    workspaceId: string;
    cpuSeconds: number;
    containerSeconds: number;
    atMs: number;
  }): Promise<void>;
  release(workspaceId: string): Promise<void>;
};

export class Workspace extends DurableObject<Env> {
  private rec: WorkspaceRecord | null | undefined = undefined;
  private machineInstance: WorkspaceMachine | null = null;
  private booting: Promise<void> | null = null;
  /** The container was (re)attached by this DO instance (egress interception is per instance). */
  private attached = false;
  private inflight = 0;

  // ------------------------------------------------------------------ seams

  private now(): number {
    return workspaceRuntime().now?.() ?? Date.now();
  }

  private machine(): WorkspaceMachine {
    if (this.machineInstance !== null) return this.machineInstance;
    const seam = workspaceRuntime().machine;
    const name = this.rec?.spec.workspaceId ?? "workspace";
    this.machineInstance =
      seam !== undefined
        ? seam(this.ctx, name)
        : new ContainerMachine({
            container: this.ctx.container,
            registries: REGISTRY_HOSTS,
            egressGateway: (props) => {
              const exportsObject: unknown = this.ctx.exports;
              if (typeof exportsObject !== "object" || exportsObject === null) return null;
              const factory: unknown = Reflect.get(exportsObject, WORKSPACE_EGRESS_EXPORT);
              if (typeof factory !== "function") return null;
              const gw: unknown = Reflect.apply(factory, exportsObject, [{ props }]);
              return typeof gw === "object" && gw !== null && "fetch" in gw
                ? (gw as Fetcher)
                : null;
            },
          });
    return this.machineInstance;
  }

  private wenv(): WorkspaceEnv {
    return this.env as unknown as WorkspaceEnv;
  }

  private ledger(repoId: string): LedgerStub {
    return this.wenv().PROJECT_LEDGER.getByName(repoId) as unknown as LedgerStub;
  }

  private async mintForkToken(scope: "read" | "write"): Promise<string> {
    const fork = this.rec?.spec.forkName ?? "";
    // Defence in depth on top of OpenSpec and the GitHost's own fork-only write guard.
    if (!isForkName(fork)) throw new Error("workspaces only ever hold tokens for a change fork");
    const { token } = await resolveRuntime(this.env, "default").ports.git.mintToken(
      fork,
      scope,
      TOKEN_TTL_SEC,
    );
    return token;
  }

  // ------------------------------------------------------------------ state

  private async load(): Promise<WorkspaceRecord | null> {
    if (this.rec !== undefined) return this.rec;
    const parsed = WorkspaceRecord.safeParse(await this.ctx.storage.get("record"));
    this.rec = parsed.success ? parsed.data : null;
    return this.rec;
  }

  private async save(rec: WorkspaceRecord): Promise<void> {
    this.rec = rec;
    await this.ctx.storage.put("record", rec);
  }

  private async patch(p: Partial<WorkspaceRecord>): Promise<WorkspaceRecord> {
    const rec = await this.load();
    if (rec === null) throw new Error("no workspace record");
    const next = { ...rec, ...p };
    await this.save(next);
    return next;
  }

  private containerSeconds(rec: WorkspaceRecord): number {
    const running = rec.containerStartedAt === null ? 0 : this.now() - rec.containerStartedAt;
    return Math.round((rec.containerMs + Math.max(0, running)) / 100) / 10;
  }

  private view(rec: WorkspaceRecord): WorkspaceViewData {
    const s = OpenSpec.parse(rec.spec);
    return {
      workspaceId: s.workspaceId,
      changeId: s.changeId,
      repoId: s.repoId,
      forkName: s.forkName,
      branch: s.branch,
      baseSha: s.baseSha,
      headSha: rec.headSha,
      status: rec.status,
      network: s.network,
      expiresAt: rec.expiresAt,
      idleSleepSec: Math.round(s.idleMs / 1000),
      restoredFrom: rec.restoredFrom,
      containerSeconds: this.containerSeconds(rec),
      lastError: rec.lastError,
      egressDenied: rec.egressDenied,
    };
  }

  /** Ends the running segment of container time. */
  private stoppedPatch(rec: WorkspaceRecord): Partial<WorkspaceRecord> {
    if (rec.containerStartedAt === null) return {};
    return {
      containerMs: rec.containerMs + Math.max(0, this.now() - rec.containerStartedAt),
      containerStartedAt: null,
    };
  }

  /** Reports container time not yet on the project ledger (including the running segment). */
  private async reportUsage(): Promise<void> {
    const rec = await this.load();
    if (rec === null) return;
    const now = this.now();
    const running = rec.containerStartedAt === null ? 0 : Math.max(0, now - rec.containerStartedAt);
    const total = rec.containerMs + running;
    const delta = total - rec.reportedMs;
    if (delta < 1000) return;
    const s = OpenSpec.parse(rec.spec);
    try {
      await this.ledger(s.repoId).recordUsage({
        workspaceId: s.workspaceId,
        containerSeconds: delta / 1000,
        cpuSeconds: (delta / 1000) * INSTANCE_VCPU[s.instance],
        atMs: now,
      });
      // The account's share of the plan's workspace quota (the project's is recordUsage above).
      await addPlanUsage(
        this.env as unknown as PlanGateEnv,
        s.repoId,
        WORKSPACE_CPU_SECONDS,
        (delta / 1000) * INSTANCE_VCPU[s.instance],
        now,
      ).catch((e: unknown) => console.warn(`workspace ${s.workspaceId}: account usage`, e));
      await recordSpend(this.env as unknown as SpendEnv, {
        source: "workspace",
        usd: containerUsd(s.instance, delta),
        repoId: s.repoId,
        ref: s.workspaceId,
        atMs: now,
      });
      await this.patch({ reportedMs: total });
    } catch (e) {
      console.error(`workspace ${s.workspaceId}: usage report failed: ${errorText(e)}`);
    }
  }

  private async scheduleAlarm(rec: WorkspaceRecord): Promise<void> {
    if (!ACTIVE.includes(rec.status)) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const s = OpenSpec.parse(rec.spec);
    const expires = Date.parse(rec.expiresAt);
    const idle = rec.status === "sleeping" ? expires : rec.lastActiveAt + s.idleMs;
    await this.ctx.storage.setAlarm(Math.max(this.now() + 1000, Math.min(expires, idle)));
  }

  private async touch(): Promise<void> {
    const rec = await this.patch({ lastActiveAt: this.now() });
    await this.scheduleAlarm(rec);
  }

  private async audit(action: string, payload: Record<string, unknown>): Promise<void> {
    const rec = await this.load();
    if (rec === null) return;
    try {
      await new DoAudit(this.env).append({
        principalId: SYSTEM_PRINCIPAL_ID,
        action,
        subject: `change:${rec.spec.changeId}`,
        payload: { workspaceId: rec.spec.workspaceId, generation: rec.generation, ...payload },
      });
    } catch (e) {
      console.error(`workspace audit ${action} failed: ${errorText(e)}`);
    }
  }

  // ------------------------------------------------------------------ boot

  private bootSpec(rec: WorkspaceRecord, from: BootFrom) {
    const s = OpenSpec.parse(rec.spec);
    const remote = new URL(s.remote);
    return {
      workspaceId: s.workspaceId,
      from,
      instance: s.instance,
      network: s.network,
      egress: { gitHost: remote.hostname.toLowerCase(), forkPath: remote.pathname },
      // Backstop only: the alarm snapshots and stops the container before this fires.
      inactivityTimeoutMs: s.idleMs + 10 * 60_000,
    };
  }

  /**
   * Starts the container and brings the checkout to `rec.headSha ?? spec.headSha`. `prefer`
   * decides the first source; an unrestorable snapshot falls back to the next one.
   */
  private async bootAndCheckout(prefer: "sleep" | "fresh"): Promise<void> {
    let rec = await this.load();
    if (rec === null) return;
    const s = OpenSpec.parse(rec.spec);
    const sources: Array<{ from: BootFrom; restored: RestoredFrom }> = [];
    if (prefer === "sleep" && rec.sleepSnapshotId !== null) {
      sources.push({
        from: { kind: "sleep-snapshot", id: rec.sleepSnapshotId },
        restored: "sleep-snapshot",
      });
    }
    if (s.depsSnapshot !== null) {
      sources.push({
        from: { kind: "dependency-snapshot", id: s.depsSnapshot.id },
        restored: "dependency-snapshot",
      });
    }
    sources.push({ from: { kind: "image" }, restored: "image" });
    const m = this.machine();
    let lastError: string | null = null;
    for (const src of sources) {
      try {
        await m.boot(this.bootSpec(rec, src.from));
      } catch (e) {
        if (e instanceof MachineError && e.code === "snapshot-unavailable") {
          lastError =
            src.restored === "sleep-snapshot"
              ? `the sleep snapshot could not be restored (${e.message}); restarted from ${src === sources.at(-1) ? "the image" : "the next source"} at the last pushed commit, so uncommitted changes were lost`
              : `the dependency snapshot could not be restored (${e.message}); started from the image`;
          await m.destroy();
          continue;
        }
        throw e;
      }
      rec = await this.patch({ containerStartedAt: this.now(), restoredFrom: src.restored });
      this.attached = true;
      if (src.restored !== "sleep-snapshot") {
        const token = await this.mintForkToken("read");
        const { head } = await m.checkout({
          remote: s.remote,
          branch: s.branch,
          headSha: rec.headSha ?? s.headSha,
          baseSha: s.baseSha,
          token,
        });
        rec = await this.patch({ headSha: head });
      }
      await this.patch({ status: "ready", lastError, sleepSnapshotId: null });
      await this.touch();
      return;
    }
  }

  /** Runs a boot unless one is in flight; records a failure on the record. */
  private startBoot(prefer: "sleep" | "fresh"): Promise<void> {
    if (this.booting !== null) return this.booting;
    const run = this.bootAndCheckout(prefer).catch(async (e: unknown) => {
      const message = errorText(e);
      await this.machine().destroy();
      const rec = await this.load();
      if (rec !== null) {
        await this.patch({
          ...this.stoppedPatch(rec),
          status: rec.status === "sleeping" ? "sleeping" : "starting",
          lastError: `the workspace could not start: ${message}`.slice(0, 2000),
        });
      }
      throw e;
    });
    this.booting = run.finally(() => {
      this.booting = null;
    });
    this.booting.catch(() => {});
    this.ctx.waitUntil(this.booting.catch(() => {}));
    return this.booting;
  }

  private async waitFor(p: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        p.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The record of an active workspace this principal owns, or an error. */
  private async requireActive(
    principalId: string,
  ): Promise<{ ok: true; rec: WorkspaceRecord } | { ok: false; error: WorkspaceErrorBody }> {
    const rec = await this.load();
    if (rec === null) {
      return err("not-found", "this workspace was never opened", {
        explanation: "Open the Change's workspace first.",
        call: 'open_workspace({ changeId: "<changeId>" })',
      });
    }
    if (rec.spec.ownerPrincipalId !== principalId) {
      return err("forbidden", "this workspace belongs to another principal", {
        explanation: "Only the principal that opened a workspace (the Change's author) may use it.",
      });
    }
    if (
      rec.status === "closed" ||
      rec.status === "expired" ||
      Date.parse(rec.expiresAt) <= this.now()
    ) {
      if (rec.status !== "closed" && rec.status !== "expired") await this.expire();
      return err(
        "invalid-state",
        `the workspace is ${rec.status === "closed" ? "closed" : "expired"}`,
        {
          explanation:
            "Open it again for a fresh session from the fork's current head; anything you pushed is kept.",
          call: `open_workspace({ changeId: "${rec.spec.changeId}" })`,
        },
      );
    }
    return { ok: true, rec };
  }

  /** Waits until the container is up (resuming or recovering it), at most `waitMs`. */
  private async ensureReady(
    rec: WorkspaceRecord,
    waitMs = 60_000,
  ): Promise<{ ok: true } | { ok: false; error: WorkspaceErrorBody }> {
    const m = this.machine();
    if (rec.status === "sleeping") {
      void this.startBoot("sleep");
    } else if (rec.status === "starting" && this.booting === null) {
      void this.startBoot("fresh");
    } else if (rec.status === "ready" && !m.running) {
      // The container stopped without a snapshot (inactivity backstop or a runtime restart):
      // start again at the last pushed/checked-out commit.
      await this.patch({
        ...this.stoppedPatch(rec),
        lastError: "the container had stopped; restarted at the last checked-out commit",
      });
      void this.startBoot("sleep");
    } else if (rec.status === "ready" && !this.attached) {
      await m.boot(this.bootSpec(rec, { kind: "image" }));
      this.attached = true;
    }
    if (this.booting !== null) await this.waitFor(this.booting, waitMs);
    const now = await this.load();
    if (now?.status !== "ready") {
      return err("invalid-state", "the workspace is still starting", {
        explanation: `${now?.lastError ?? "The container is booting and checking out the fork."} Retry the same call in a few seconds.`,
        call: `open_workspace({ changeId: "${rec.spec.changeId}" })`,
      });
    }
    return { ok: true };
  }

  /** Runs an operation on a ready workspace, with activity and usage bookkeeping. */
  private async op<T>(
    principalId: string,
    fn: (rec: WorkspaceRecord, m: WorkspaceMachine) => Promise<WorkspaceResult<T>>,
  ): Promise<WorkspaceResult<T>> {
    const active = await this.requireActive(principalId);
    if (!active.ok) return active;
    const ready = await this.ensureReady(active.rec);
    if (!ready.ok) return ready;
    this.inflight += 1;
    try {
      await this.touch();
      const rec = await this.load();
      if (rec === null) throw new Error("no workspace record");
      return await fn(rec, this.machine());
    } catch (e) {
      return err("upstream", `the workspace failed: ${errorText(e)}`, {
        explanation: "The sandbox failed while running this. Retrying is safe.",
      });
    } finally {
      this.inflight -= 1;
      await this.touch().catch(() => {});
      await this.reportUsage();
    }
  }

  // ------------------------------------------------------------------ RPC

  /** Starts a new session, or resumes the active one (idempotent per owner). */
  async open(raw: unknown): Promise<WorkspaceResult<WorkspaceViewData>> {
    const parsed = OpenSpec.safeParse(raw);
    if (!parsed.success) {
      return err("invalid-input", `invalid workspace spec: ${parsed.error.issues[0]?.message}`, {
        explanation: "Internal error opening the workspace.",
      });
    }
    const spec = parsed.data;
    let rec = await this.load();
    if (rec !== null && ACTIVE.includes(rec.status) && Date.parse(rec.expiresAt) <= this.now()) {
      await this.expire();
      rec = await this.load();
    }
    if (rec !== null && ACTIVE.includes(rec.status)) {
      if (rec.spec.ownerPrincipalId !== spec.ownerPrincipalId) {
        return err("forbidden", "this workspace is open for another principal", {
          explanation: "Only the Change's author may open its workspace.",
        });
      }
      if (rec.status === "sleeping") void this.startBoot("sleep");
      else if (rec.status === "starting" && this.booting === null) void this.startBoot("fresh");
      if (this.booting !== null) await this.waitFor(this.booting, spec.waitMs);
      await this.touch();
      const now = await this.load();
      return { ok: true, value: this.view(now ?? rec) };
    }
    const at = this.now();
    const fresh: WorkspaceRecord = {
      v: 1,
      spec,
      status: "starting",
      generation: (rec?.generation ?? 0) + 1,
      openedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + spec.ttlMs).toISOString(),
      lastActiveAt: at,
      headSha: null,
      sleepSnapshotId: null,
      restoredFrom: null,
      containerStartedAt: null,
      containerMs: 0,
      reportedMs: 0,
      lastError: null,
      egressDenied: 0,
    };
    await this.save(fresh);
    this.machineInstance = null;
    this.attached = false;
    await this.scheduleAlarm(fresh);
    await this.waitFor(this.startBoot("fresh"), spec.waitMs);
    const now = await this.load();
    return { ok: true, value: this.view(now ?? fresh) };
  }

  async describe(principalId: string): Promise<WorkspaceResult<WorkspaceViewData>> {
    const rec = await this.load();
    if (rec === null || rec.spec.ownerPrincipalId !== principalId) {
      return err("not-found", "no such workspace", {
        explanation: "Open the Change's workspace first.",
      });
    }
    return { ok: true, value: this.view(rec) };
  }

  async exec(
    principalId: string,
    input: { command: string; cwd: string; timeoutSec: number; budgetSec: number | null },
  ): Promise<WorkspaceResult<ExecOutcome>> {
    return this.op(principalId, async (rec, m) => {
      const s = OpenSpec.parse(rec.spec);
      const ttlLeft = Math.floor((Date.parse(rec.expiresAt) - this.now()) / 1000);
      const timeoutSec = Math.max(
        1,
        Math.min(
          input.timeoutSec,
          s.maxExecTimeoutSec,
          ttlLeft,
          input.budgetSec ?? Number.POSITIVE_INFINITY,
        ),
      );
      const cwd = checkWorkspacePath(input.cwd, { allowRoot: true });
      if (!cwd.ok) {
        return err("invalid-input", `cwd ${cwd.reason}`, {
          explanation: "Pass a directory relative to the repository root.",
        });
      }
      const value = await m.exec({
        command: input.command,
        cwd: cwd.path,
        timeoutSec,
        maxOutputBytes: s.maxOutputBytes,
        author: s.author,
      });
      return { ok: true, value };
    });
  }

  async read(
    principalId: string,
    input: { path: string; startLine?: number; endLine?: number },
  ): Promise<WorkspaceResult<WsReadData>> {
    return this.op<WsReadData>(principalId, async (_rec, m) => {
      const p = checkWorkspacePath(input.path);
      if (!p.ok) return pathError(input.path, p.reason);
      const r = await m.read(p.path, MAX_READ_BYTES);
      if (!r.ok) {
        if (r.reason === "outside") return pathError(input.path, r.message);
        if (r.reason === "missing") {
          return err("not-found", `${p.path} does not exist in the workspace`, {
            explanation: "List files to find the right path.",
            call: `ws_exec({ workspaceId: "<workspaceId>", command: "git ls-files | head -200" })`,
          });
        }
        return err("invalid-input", `${p.path}: ${r.message}`, {
          explanation: "ws_read reads regular files; use ws_exec for anything else.",
        });
      }
      const binary = r.bytes.subarray(0, 8192).includes(0);
      if (binary) {
        return {
          ok: true,
          value: {
            path: p.path,
            content: "",
            binary: true,
            sizeBytes: r.size,
            totalLines: 0,
            startLine: 0,
            endLine: 0,
            truncated: r.size > r.bytes.byteLength,
          },
        };
      }
      const text = new TextDecoder().decode(r.bytes);
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const total = lines.length;
      const start = Math.min(Math.max(1, input.startLine ?? 1), Math.max(total, 1));
      const end = Math.min(input.endLine ?? total, total);
      const slice = lines.slice(start - 1, Math.max(end, start - 1));
      const ranged = input.startLine !== undefined || input.endLine !== undefined;
      return {
        ok: true,
        value: {
          path: p.path,
          content: ranged ? `${slice.join("\n")}${slice.length > 0 ? "\n" : ""}` : text,
          binary: false,
          sizeBytes: r.size,
          totalLines: total,
          startLine: total === 0 ? 0 : start,
          endLine: total === 0 ? 0 : Math.max(end, start - 1),
          truncated: r.size > r.bytes.byteLength,
        },
      };
    });
  }

  async write(
    principalId: string,
    input: { path: string; content?: string; patch?: string },
  ): Promise<
    WorkspaceResult<{ path: string; mode: "content" | "patch"; bytes: number; created: boolean }>
  > {
    return this.op<WsWriteData>(principalId, async (_rec, m) => {
      const p = checkWorkspacePath(input.path);
      if (!p.ok) return pathError(input.path, p.reason);
      if (input.patch !== undefined) {
        const r = await m.applyPatch(p.path, input.patch);
        if (!r.ok) {
          return r.reason === "outside"
            ? pathError(input.path, r.message)
            : err("invalid-input", `the patch does not apply: ${r.message}`, {
                explanation:
                  "Read the file again (ws_read) and send a unified diff against its current content, or send the whole file as `content`.",
                call: `ws_read({ workspaceId: "<workspaceId>", path: "${p.path}" })`,
              });
        }
        return {
          ok: true,
          value: { path: p.path, mode: "patch", bytes: input.patch.length, created: false },
        };
      }
      const bytes = new TextEncoder().encode(input.content ?? "");
      const r = await m.write(p.path, bytes);
      if (!r.ok) {
        return r.reason === "outside"
          ? pathError(input.path, r.message)
          : err("invalid-input", `${p.path}: ${r.message}`, {
              explanation: "ws_write writes regular files inside the repository.",
            });
      }
      return {
        ok: true,
        value: { path: p.path, mode: "content", bytes: bytes.byteLength, created: r.created },
      };
    });
  }

  async diff(principalId: string): Promise<WorkspaceResult<DiffOutcome & { baseSha: string }>> {
    return this.op(principalId, async (rec, m) => {
      const s = OpenSpec.parse(rec.spec);
      const d = await m.diff(s.baseSha, MAX_DIFF_BYTES);
      return { ok: true, value: { ...d, baseSha: s.baseSha } };
    });
  }

  async commitPush(
    principalId: string,
    input: { message: string },
  ): Promise<
    WorkspaceResult<{
      branch: string;
      commitSha: string;
      previousHead: string | null;
      filesChanged: number;
      pushed: boolean;
    }>
  > {
    return this.op(principalId, async (rec, m) => {
      const s = OpenSpec.parse(rec.spec);
      const pushedHead = rec.headSha ?? s.headSha;
      const token = await this.mintForkToken("write");
      const r: CommitPushOutcome = await m.commitPush({
        remote: s.remote,
        branch: s.branch,
        message: input.message,
        author: s.author,
        token,
        pushedHead,
      });
      if (r.status === "nothing") {
        return err("invalid-state", "nothing to commit or push: the workspace matches the fork", {
          explanation: "Change something first (ws_write or ws_exec), then commit and push.",
          call: `ws_diff({ workspaceId: "${s.workspaceId}" })`,
        });
      }
      if (r.status === "rejected") {
        return err("conflict", `the push to ${s.forkName} was rejected: ${r.message}`, {
          explanation:
            "The fork's branch moved since this workspace checked it out (someone pushed from elsewhere). Close this workspace and open it again to continue from the fork's head.",
          call: `close_workspace({ workspaceId: "${s.workspaceId}" })`,
        });
      }
      await this.patch({ headSha: r.head });
      return {
        ok: true,
        value: {
          branch: s.branch,
          commitSha: r.head,
          previousHead: pushedHead,
          filesChanged: r.files,
          pushed: true,
        },
      };
    });
  }

  /** Stops the workspace for good (the owner, or the platform). */
  async close(principalId: string, reason = "closed"): Promise<WorkspaceResult<WorkspaceViewData>> {
    const rec = await this.load();
    if (rec === null) {
      return err("not-found", "this workspace was never opened", {
        explanation: "Nothing to close.",
      });
    }
    if (rec.spec.ownerPrincipalId !== principalId && principalId !== SYSTEM_PRINCIPAL_ID) {
      return err("forbidden", "this workspace belongs to another principal", {
        explanation: "Only the principal that opened a workspace may close it.",
      });
    }
    if (rec.status === "closed" || rec.status === "expired")
      return { ok: true, value: this.view(rec) };
    await this.stop("closed", reason);
    const now = await this.load();
    return { ok: true, value: this.view(now ?? rec) };
  }

  /** Called by WorkspaceEgressGateway for each refused request. */
  async noteEgressDenied(denial: { method: string; url: string; reason: string }): Promise<void> {
    const rec = await this.load();
    if (rec === null) return;
    await this.patch({ egressDenied: rec.egressDenied + 1 });
    if (rec.egressDenied < 20) {
      console.log(
        `workspace ${rec.spec.workspaceId}: egress blocked ${denial.method} ${denial.url} (${denial.reason})`,
      );
    }
  }

  // ------------------------------------------------------------------ lifecycle

  private async stop(status: "closed" | "expired", reason: string): Promise<void> {
    const rec = await this.load();
    if (rec === null) return;
    await this.machine().destroy();
    await this.patch({ ...this.stoppedPatch(rec), status, sleepSnapshotId: null });
    this.attached = false;
    await this.reportUsage();
    await this.ledger(rec.spec.repoId)
      .release(rec.spec.workspaceId)
      .catch(() => {});
    await this.ctx.storage.deleteAlarm();
    // Closing is audited by the service as the caller; expiry is the platform's own action.
    if (status === "expired") {
      await this.audit("workspace.expired", {
        reason,
        containerSeconds: this.containerSeconds((await this.load()) ?? rec),
      });
    }
  }

  private async expire(): Promise<void> {
    await this.stop("expired", "ttl");
  }

  /** Snapshot + stop: the next call resumes from the snapshot. */
  private async sleep(): Promise<void> {
    const rec = await this.load();
    if (rec === null || rec.status !== "ready") return;
    const m = this.machine();
    let snapshotId: string | null = null;
    let lastError = rec.lastError;
    try {
      if (m.running) {
        snapshotId = (await m.snapshot(`${rec.spec.workspaceId}-g${rec.generation}`)).id;
      }
    } catch (e) {
      lastError = `sleeping without a snapshot (${errorText(e)}): uncommitted changes will be lost`;
    }
    await m.destroy();
    this.attached = false;
    await this.patch({
      ...this.stoppedPatch(rec),
      status: "sleeping",
      sleepSnapshotId: snapshotId,
      lastError,
    });
    await this.reportUsage();
    const now = await this.load();
    if (now !== null) await this.scheduleAlarm(now);
  }

  override async alarm(): Promise<void> {
    const rec = await this.load();
    if (rec === null || !ACTIVE.includes(rec.status)) return;
    const s = OpenSpec.parse(rec.spec);
    const now = this.now();
    if (now >= Date.parse(rec.expiresAt)) {
      await this.expire();
      return;
    }
    if (rec.status === "ready" && now - rec.lastActiveAt >= s.idleMs) {
      if (this.inflight > 0 || this.booting !== null) {
        await this.ctx.storage.setAlarm(now + 60_000);
        return;
      }
      await this.sleep();
      return;
    }
    await this.reportUsage();
    await this.scheduleAlarm(rec);
  }
}

function pathError(path: string, reason: string): { ok: false; error: WorkspaceErrorBody } {
  return err("invalid-input", `path ${JSON.stringify(path)} ${reason}`, {
    explanation:
      "Workspace paths are relative to the repository root (/workspace) and must stay inside it; .git is off limits.",
  });
}
