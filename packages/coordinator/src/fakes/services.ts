/** In-memory fakes for the smaller ports: signer, audit, notifier, clock, release, reviewer. */
import type { ClassifyResult } from "@app/classifier";
import type { AuditEvent, Change, ChangeDiff, LinkedIssue, Plan, Tour } from "@app/domain";
import {
  canonicalBytes,
  type EvidencePayload,
  type LlmJudgment,
  type Screenshots,
  type SignedEvidence,
  sha256Base64url,
} from "@app/evidence";
import { flagKeyFor } from "../ids.js";
import type {
  Audit,
  Budget,
  Clock,
  Deployer,
  Flags,
  Notifier,
  Onboarding,
  PreviewOutcome,
  PreviewRequest,
  Previews,
  Reviewer,
  Signer,
  Telemetry,
} from "../ports.js";

// ---------------------------------------------------------------- clock

export class FakeClock implements Clock {
  private t: number;
  constructor(start = "2026-10-01T12:00:00.000Z") {
    this.t = Date.parse(start);
  }
  now(): Date {
    return new Date(this.t);
  }
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

// ---------------------------------------------------------------- signer

/** Not cryptography: the "signature" is the canonical payload digest, so tampering is detected. */
export class FakeSigner implements Signer {
  readonly keyId = "fake-key";
  /** Make every verification fail (unverified evidence → blocked). */
  failVerification = false;
  readonly documents: unknown[] = [];

  async signEvidence(payload: EvidencePayload): Promise<SignedEvidence> {
    const { changeId, headSha, items } = payload;
    const digest = await sha256Base64url(canonicalBytes({ changeId, headSha, items }));
    return {
      changeId,
      headSha,
      items,
      attestation: {
        v: 1,
        alg: "Ed25519",
        keyId: this.keyId,
        payloadDigest: digest,
        signature: `fake.${digest}`,
        signedAt: "2026-10-01T12:00:00.000Z",
        signer: "fake-signer",
      },
    };
  }

  async verifyEvidence(signed: SignedEvidence): Promise<{ ok: boolean; reason?: string }> {
    if (this.failVerification) return { ok: false, reason: "verification disabled by the test" };
    const digest = await sha256Base64url(
      canonicalBytes({ changeId: signed.changeId, headSha: signed.headSha, items: signed.items }),
    );
    return digest === signed.attestation.payloadDigest &&
      signed.attestation.signature === `fake.${digest}`
      ? { ok: true }
      : { ok: false, reason: "digest mismatch" };
  }

  async signDocument(value: unknown): Promise<string> {
    this.documents.push(value);
    return `fake-doc.${await sha256Base64url(canonicalBytes(value))}`;
  }
}

// ---------------------------------------------------------------- audit & notify

export class FakeAudit implements Audit {
  readonly events: AuditEvent[] = [];
  readonly payloads: unknown[] = [];
  constructor(private readonly clock: Clock) {}

  async append(input: {
    principalId: string;
    action: string;
    subject: string;
    payload: unknown;
  }): Promise<AuditEvent> {
    const seq = this.events.length;
    const prevHash = this.events[seq - 1]?.hash ?? "A".repeat(43);
    const event: AuditEvent = {
      seq,
      at: this.clock.now().toISOString(),
      principalId: input.principalId,
      action: input.action,
      subject: input.subject,
      payloadHash: `p${seq}`,
      prevHash,
      hash: `h${seq}`,
      signature: `s${seq}`,
      keyId: "fake-key",
    };
    this.events.push(event);
    this.payloads.push(structuredClone(input.payload));
    return event;
  }

  actions(subject?: string): string[] {
    return this.events
      .filter((e) => subject === undefined || e.subject === subject)
      .map((e) => e.action);
  }

  payloadOf(action: string): unknown {
    const i = this.events.findIndex((e) => e.action === action);
    return i < 0 ? undefined : this.payloads[i];
  }
}

export class FakeNotifier implements Notifier {
  readonly sent: Array<Parameters<Notifier["notify"]>[0]> = [];
  async notify(input: Parameters<Notifier["notify"]>[0]): Promise<void> {
    this.sent.push(input);
  }
  kinds(changeId?: string): string[] {
    return this.sent
      .filter((n) => changeId === undefined || n.changeId === changeId)
      .map((n) => n.kind);
  }
}

// ---------------------------------------------------------------- release

export class FakeDeployer implements Deployer {
  readonly live = new Map<string, Array<{ versionId: string; percentage: number }>>();
  readonly uploads: Array<{
    script: string;
    changeId: string;
    sha: string;
    bundleRef: string;
    flagshipAppId: string;
    versionId: string;
  }> = [];
  readonly splits: Array<{
    script: string;
    split: Array<{ versionId: string; percentage: number }>;
  }> = [];
  readonly rollbacks: Array<{ script: string; versionId: string; message: string }> = [];
  private n = 0;

  async uploadVersion(input: {
    script: string;
    changeId: string;
    sha: string;
    bundleRef: string;
    message: string;
    flagshipAppId: string;
  }) {
    const versionId = `v${++this.n}-${input.changeId}`;
    this.uploads.push({ ...input, versionId });
    return { versionId };
  }
  async currentVersions(script: string) {
    return structuredClone(this.live.get(script) ?? []);
  }
  async setSplit(script: string, split: Array<{ versionId: string; percentage: number }>) {
    this.splits.push({ script, split: structuredClone(split) });
    this.live.set(script, structuredClone(split));
  }
  async rollback(script: string, versionId: string, message: string) {
    this.rollbacks.push({ script, versionId, message });
    this.live.set(script, [{ versionId, percentage: 100 }]);
  }
}

/**
 * In-memory Flagship: apps with their flags. `flags` is every app's flags by key (keys embed the
 * change id, so they never collide); `apps` keeps them per app for isolation tests.
 */
export class FakeFlags implements Flags {
  readonly apps = new Map<string, { name: string; flags: Map<string, boolean> }>();
  readonly flags = new Map<string, boolean>();
  readonly history: Array<{ appId: string; key: string; enabled: boolean }> = [];
  readonly deleted: string[] = [];
  private n = 0;
  async ensureApp(name: string) {
    for (const [id, app] of this.apps) if (app.name === name) return id;
    const id = `app-${++this.n}-${name}`;
    this.apps.set(id, { name, flags: new Map() });
    return id;
  }
  async deleteApp(appId: string) {
    const app = this.apps.get(appId);
    if (app === undefined) return;
    for (const key of app.flags.keys()) this.flags.delete(key);
    this.apps.delete(appId);
    this.deleted.push(appId);
  }
  private app(appId: string) {
    const app = this.apps.get(appId);
    if (app === undefined) throw new Error(`Flagship app ${appId} not found`);
    return app;
  }
  async ensureChangeFlag(
    appId: string,
    changeId: string,
    opts: { enabled: boolean; description?: string },
  ) {
    const app = this.app(appId);
    const key = flagKeyFor(changeId);
    if (!app.flags.has(key)) {
      app.flags.set(key, opts.enabled);
      this.flags.set(key, opts.enabled);
      this.history.push({ appId, key, enabled: opts.enabled });
    }
    return key;
  }
  async setEnabled(appId: string, flagKey: string, enabled: boolean) {
    this.app(appId).flags.set(flagKey, enabled);
    this.flags.set(flagKey, enabled);
    this.history.push({ appId, key: flagKey, enabled });
  }
}

export type TelemetryResult = Awaited<ReturnType<Telemetry["check"]>>;

/** Scripted telemetry: queued results (or errors) first, then `fallback`. */
export class FakeTelemetry implements Telemetry {
  readonly queue: Array<Partial<TelemetryResult> | Error> = [];
  fallback: TelemetryResult = {
    requests: 1000,
    errorRate: 0.001,
    baselineErrorRate: 0.001,
    newIssueGroups: 0,
    issues: [],
  };
  readonly calls: Array<Parameters<Telemetry["check"]>[0]> = [];
  async check(input: Parameters<Telemetry["check"]>[0]): Promise<TelemetryResult> {
    this.calls.push(input);
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return { ...this.fallback, ...(next ?? {}) };
  }
}

// ---------------------------------------------------------------- reviewer

export class FakeReviewer implements Reviewer {
  judgeItems: LlmJudgment[] = [];
  judgeCostUsd = 0.01;
  judgeError: Error | null = null;
  tourOutcome: "ok" | "failed" = "ok";
  tourCostUsd = 0.02;
  budgetExceeded = false;
  readonly judgeCalls: Array<{
    plan: Plan | null;
    diff: ChangeDiff;
    budget: Budget;
    model?: string;
  }> = [];
  readonly tourCalls: Array<{
    change: Pick<Change, "id" | "title" | "headSha" | "baseSha">;
    classification: ClassifyResult;
    budget: Budget;
    model?: string | undefined;
  }> = [];

  async judge(input: { plan: Plan | null; diff: ChangeDiff; budget: Budget; model?: string }) {
    this.judgeCalls.push(structuredClone(input));
    if (this.judgeError !== null) throw this.judgeError;
    return {
      items: structuredClone(this.judgeItems),
      costUsd: this.judgeCostUsd,
      budgetExceeded: this.budgetExceeded,
    };
  }

  async tour(input: {
    change: Pick<Change, "id" | "title" | "headSha" | "baseSha">;
    plan: Plan | null;
    diff: ChangeDiff;
    evidence: SignedEvidence;
    classification: ClassifyResult;
    budget: Budget;
    model?: string;
  }) {
    this.tourCalls.push(
      structuredClone({
        change: input.change,
        classification: input.classification,
        budget: input.budget,
        model: input.model,
      }),
    );
    if (this.tourOutcome === "failed") {
      return {
        status: "failed" as const,
        reason: "schema validation failed twice",
        costUsd: this.tourCostUsd,
        budgetExceeded: this.budgetExceeded,
      };
    }
    const headSha = input.change.headSha ?? "0".repeat(40);
    const tour: Tour = {
      id: `tour-${input.change.id}-${headSha.slice(0, 8)}`,
      changeId: input.change.id,
      headSha,
      stops: [
        {
          kind: "intent",
          title: "What this change does",
          why: "It implements the plan's intent.",
          hunkRefs: [],
          evidenceRefs: input.evidence.items.slice(0, 1).map((i) => i.id),
          verdict: "proven",
        },
      ],
      leastConfident: ["Nothing in particular."],
      notDone: ["Nothing left out."],
      generatedBy: {
        principalId: "reviewer-agent",
        model: "fake",
        promptVersion: "1",
        attempts: 1,
        costUsd: this.tourCostUsd,
      },
      createdAt: "2026-10-01T12:00:00.000Z",
    };
    return {
      status: "ok" as const,
      tour,
      costUsd: this.tourCostUsd,
      budgetExceeded: this.budgetExceeded,
    };
  }
}

export function linkedIssue(overrides: Partial<LinkedIssue> = {}): LinkedIssue {
  return {
    id: "issue-1",
    changeId: null,
    title: "TypeError: x is undefined",
    count: 3,
    firstSeen: "2026-10-01T12:00:30.000Z",
    lastSeen: "2026-10-01T12:00:40.000Z",
    versionId: null,
    url: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------- previews, onboarding

/** Previews that are "ready" whenever CI left a build snapshot (opt in: `ports.previews = …`). */
export class FakePreviews implements Previews {
  readonly starts: PreviewRequest[] = [];
  readonly screenshotCalls: Array<{ changeId: string; url: string; routes: string[] }> = [];
  outcome: (req: PreviewRequest) => PreviewOutcome = (req) =>
    req.snapshots.build === undefined
      ? { status: "skipped", url: null, reason: "no build snapshot" }
      : {
          status: "ready",
          url: `https://p-${req.changeId}.preview.test`,
          pinnedUrl: `https://p-${req.changeId}-${req.headSha.slice(0, 8)}.preview.test`,
          readyMs: 1500,
        };
  screenshotError: Error | null = null;

  async start(req: PreviewRequest): Promise<PreviewOutcome> {
    this.starts.push(structuredClone(req));
    return this.outcome(req);
  }

  async screenshots(input: {
    changeId: string;
    headSha: string;
    url: string;
    routes: string[];
  }): Promise<Screenshots> {
    this.screenshotCalls.push({ changeId: input.changeId, url: input.url, routes: input.routes });
    if (this.screenshotError !== null) throw this.screenshotError;
    return {
      id: "screenshots",
      kind: "screenshots",
      status: "ok",
      shots: input.routes.map((route) => ({
        route,
        viewport: "desktop" as const,
        afterRef: `screenshots/${input.changeId}/${input.headSha.slice(0, 12)}/desktop${route === "/" ? "/index" : route}.png`,
      })),
    };
  }
}

export class FakeOnboarding implements Onboarding {
  readonly events: Array<Parameters<Onboarding["bootstrapReady"]>[0]> = [];
  async bootstrapReady(input: Parameters<Onboarding["bootstrapReady"]>[0]): Promise<void> {
    this.events.push(structuredClone(input));
  }
}
