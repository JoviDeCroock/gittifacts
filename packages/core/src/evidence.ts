/**
 * Evidence assembly (pure). CI items are untrusted input: each is validated against the evidence
 * schema, and invalid ones are dropped, which leaves the signal missing (→ the classifier
 * escalates). Kinds the platform computes itself (sensitive paths, model judgments) are never
 * taken from CI. Host-agnostic: the same items for the same change on every host.
 */
import type { ChangeDiff, RepoPolicy } from "@app/domain";
import {
  type AgentTrace,
  EvidenceItem,
  type EvidenceKind,
  type LlmJudgment,
  type PreviewDeploy,
  type Screenshots,
  type SensitivePathHits,
  sensitivePathHits,
} from "@app/evidence";

export interface AssembledEvidence {
  items: EvidenceItem[];
  /** Why CI items were dropped (schema failures, Worker-owned kinds). */
  dropped: string[];
}

/** Kinds the Worker computes itself; CI-provided items of these kinds are ignored. */
const WORKER_OWNED: ReadonlySet<EvidenceKind> = new Set(["sensitive-paths", "llm-judgment"]);

/** Every path a diff touches, including rename/copy sources (moving a sensitive file away counts). */
export function touchedPaths(diff: ChangeDiff): string[] {
  const paths = new Set<string>();
  for (const f of diff.files) {
    paths.add(f.path);
    if (f.previousPath !== null) paths.add(f.previousPath);
  }
  return [...paths].sort();
}

function sensitiveItem(diff: ChangeDiff | null, policy: RepoPolicy): SensitivePathHits {
  if (diff === null) {
    return {
      id: "sensitive-paths",
      kind: "sensitive-paths",
      status: "error",
      note: "the diff could not be computed, so sensitive paths are unknown",
      patterns: [...policy.sensitivePaths],
      hits: [],
    };
  }
  return sensitivePathHits(touchedPaths(diff), policy.sensitivePaths);
}

function agentTraceItem(traceId: string): AgentTrace {
  const m = /^([a-z][a-z0-9+.-]{0,30}):(.+)$/i.exec(traceId);
  const isUrl = /^https?:\/\//i.test(traceId);
  return {
    id: "agent-trace",
    kind: "agent-trace",
    status: "ok",
    provider: isUrl ? "url" : (m?.[1] ?? "unknown"),
    traceId: isUrl ? traceId : (m?.[2] ?? traceId),
    ...(isUrl ? { url: traceId } : {}),
  };
}

export function assembleEvidence(input: {
  ciItems: readonly unknown[];
  diff: ChangeDiff | null;
  policy: RepoPolicy;
  agentTraceId: string | null;
  /** Items the Worker produced itself (preview, screenshots); CI items of these kinds are dropped. */
  workerItems?: readonly EvidenceItem[];
}): AssembledEvidence {
  const items: EvidenceItem[] = [];
  const dropped: string[] = [];
  const workerKinds = new Set((input.workerItems ?? []).map((i) => i.kind));
  input.ciItems.forEach((raw, index) => {
    const parsed = EvidenceItem.safeParse(raw);
    if (!parsed.success) {
      const kind =
        typeof raw === "object" && raw !== null
          ? String((raw as { kind?: unknown }).kind)
          : typeof raw;
      dropped.push(`item ${index} (${kind}): ${parsed.error.issues[0]?.message ?? "invalid"}`);
      return;
    }
    if (WORKER_OWNED.has(parsed.data.kind) || workerKinds.has(parsed.data.kind)) {
      dropped.push(`item ${index} (${parsed.data.kind}): computed by the platform, not CI`);
      return;
    }
    items.push(parsed.data);
  });
  items.push(...(input.workerItems ?? []));

  items.push(sensitiveItem(input.diff, input.policy));
  const has = (kind: EvidenceKind) => items.some((i) => i.kind === kind);
  if (!has("preview")) {
    const preview: PreviewDeploy = {
      id: "preview",
      kind: "preview",
      status: "skipped",
      note: "no preview deploy was produced for this change (informational)",
    };
    items.push(preview);
  }
  if (!has("screenshots")) {
    const shots: Screenshots = {
      id: "screenshots",
      kind: "screenshots",
      status: "skipped",
      note: "screenshots need a preview deploy (informational)",
      shots: [],
    };
    items.push(shots);
  }
  if (!has("agent-trace")) {
    items.push(
      input.agentTraceId !== null
        ? agentTraceItem(input.agentTraceId)
        : ({
            id: "agent-trace",
            kind: "agent-trace",
            status: "skipped",
            note: "no agent trace was linked to this change (informational)",
            provider: "none",
            traceId: "none",
          } satisfies AgentTrace),
    );
  }
  return { items: uniqueIds(items), dropped };
}

/** Tours cite items by id, so ids must be unique within a bundle. */
export function uniqueIds(items: readonly EvidenceItem[]): EvidenceItem[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const n = seen.get(item.id) ?? 0;
    seen.set(item.id, n + 1);
    return n === 0 ? item : { ...item, id: `${item.id}#${n + 1}` };
  });
}

/** Model judgments are only ever `llm-judgment` items (raise-only in the classifier). */
export function judgmentItems(raw: readonly LlmJudgment[]): LlmJudgment[] {
  const out: LlmJudgment[] = [];
  for (const j of raw) {
    const parsed = EvidenceItem.safeParse({ ...j, kind: "llm-judgment" });
    if (parsed.success && parsed.data.kind === "llm-judgment") out.push(parsed.data);
  }
  return out;
}

export function erroredJudgment(reason: string): LlmJudgment {
  return {
    id: "llm-judgment:error",
    kind: "llm-judgment",
    status: "error",
    note: reason.slice(0, 4000),
    question: "plan-conformance",
    outcome: "unsure",
    rationale: "The model judge could not run; its signal is unknown.",
    model: "unavailable",
  };
}

export interface SealedEvidence {
  evidenceId: string;
  verified: boolean;
  itemCount: number;
}
