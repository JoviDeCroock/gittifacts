/**
 * JSON Schemas for the MCP tools, written as `as const` literals so mcp-tada can type
 * arguments and `structuredContent` at compile time. Inputs are closed
 * (`additionalProperties: false`); outputs are open. Constraints mirror @app/domain's zod schemas,
 * which the handlers still parse as defence in depth.
 */

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;
const int = { type: "integer" } as const;
const bool = { type: "boolean" } as const;
const id = { type: "string", minLength: 1, maxLength: 64 } as const;
const lane = { enum: [0, 1, 2] } as const;
const laneOrNull = { enum: [0, 1, 2, null] } as const;

const idempotencyKey = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description:
    "Optional. Retrying with the same key returns the first result instead of acting twice.",
} as const;

export const CHANGE_STATUSES = [
  "awaiting-push",
  "running",
  "failing",
  "awaiting-review",
  "approved",
  "queued",
  "merged",
  "rolling-out",
  "released",
  "reverted",
  "rejected",
  "abandoned",
] as const;

export const CATEGORIES = [
  "fix",
  "feature",
  "refactor",
  "dependency",
  "transform",
  "revert",
  "docs",
  "chore",
] as const;

export const WAIT_UNTIL = [
  "evidence_ready",
  "lane_assigned",
  "tour_ready",
  "merged",
  "reverted",
] as const;

const NextSteps = {
  type: "array",
  description: "What to do next, as concrete tool calls.",
  items: {
    type: "object",
    properties: { title: str, call: str, why: str },
    required: ["title"],
  },
} as const;

const LaneReason = {
  type: "object",
  properties: { code: str, lane, message: str },
  required: ["code", "lane", "message"],
} as const;

const ChangeBrief = {
  type: "object",
  properties: {
    id: str,
    repoId: str,
    planId: nullableStr,
    title: str,
    category: { enum: CATEGORIES },
    status: { enum: CHANGE_STATUSES },
    lane: laneOrNull,
    computedLane: laneOrNull,
    laneReasons: { type: "array", items: LaneReason },
    baseSha: str,
    headSha: nullableStr,
    forkName: str,
    mergedSha: nullableStr,
    revertOf: nullableStr,
    updatedAt: str,
  },
  required: [
    "id",
    "repoId",
    "planId",
    "title",
    "category",
    "status",
    "lane",
    "computedLane",
    "laneReasons",
    "baseSha",
    "headSha",
    "forkName",
    "mergedSha",
    "revertOf",
    "updatedAt",
  ],
} as const;

const GitRemote = {
  type: "object",
  description:
    "Push grant for the change's fork only. Short-lived; refresh with refresh_push_token.",
  properties: { url: str, username: str, token: str, expiresAt: str, branch: str },
  required: ["url", "username", "token", "expiresAt", "branch"],
} as const;

const LaneCounts = {
  type: "object",
  properties: {
    lane0: int,
    lane1: int,
    lane2: int,
    awaitingReview: int,
    rollingOut: int,
    failing: int,
  },
  required: ["lane0", "lane1", "lane2", "awaitingReview", "rollingOut", "failing"],
} as const;

const Claim = {
  type: "object",
  properties: {
    status: { enum: ["claimed", "unclaimed"] },
    ownerId: nullableStr,
    expiresAt: nullableStr,
  },
  required: ["status", "ownerId", "expiresAt"],
} as const;

// ---------------------------------------------------------------- inputs

export const EmptyInput = { type: "object", properties: {}, additionalProperties: false } as const;

export const ChangeIdInput = {
  type: "object",
  properties: { changeId: id },
  required: ["changeId"],
  additionalProperties: false,
} as const;

export const CreatePlanInput = {
  type: "object",
  properties: {
    repoId: id,
    title: { type: "string", minLength: 3, maxLength: 200 },
    intent: {
      type: "string",
      minLength: 10,
      maxLength: 10000,
      description: "Why: the problem and the intended outcome.",
    },
    acceptanceCriteria: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 1000 },
      description: "Observable results a reviewer can check.",
    },
    outOfScope: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 1000 },
    },
    riskDeclarations: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          area: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", minLength: 1, maxLength: 2000 },
        },
        required: ["area", "description"],
        additionalProperties: false,
      },
    },
    scopePaths: {
      type: "array",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 300 },
      // Avoid the sequence slash-star-star in descriptions: mcp-tada 0.4.0's snapshot parser strips it as JSDoc.
      description:
        'Globs of the paths the change will touch, like "docs/*.md". Leaving them out blocks Lane 0.',
    },
    affectedRoutes: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } },
    supersedes: { ...id, description: "Plan id this plan replaces." },
    idempotencyKey,
  },
  required: ["repoId", "title", "intent", "acceptanceCriteria"],
  additionalProperties: false,
} as const;

export const StartChangeInput = {
  type: "object",
  properties: {
    repoId: id,
    planId: { ...id, description: "The approved plan this change implements." },
    title: { type: "string", minLength: 1, maxLength: 200 },
    category: {
      enum: CATEGORIES,
      description: "Your claim; it can only raise risk, never lower it.",
    },
    summary: { type: "string", maxLength: 10000 },
    agentTraceId: { type: "string", maxLength: 200 },
    idempotencyKey,
  },
  required: ["repoId", "title", "category"],
  additionalProperties: false,
} as const;

export const RequestReviewInput = {
  type: "object",
  properties: { changeId: id, message: { type: "string", maxLength: 2000 }, idempotencyKey },
  required: ["changeId"],
  additionalProperties: false,
} as const;

export const RefreshPushTokenInput = {
  type: "object",
  properties: { changeId: id, idempotencyKey },
  required: ["changeId"],
  additionalProperties: false,
} as const;

export const WaitForChangeInput = {
  type: "object",
  properties: {
    changeId: id,
    until: { enum: WAIT_UNTIL },
    timeoutSec: { type: "integer", minimum: 1, maximum: 600, description: "Default 120." },
  },
  required: ["changeId", "until"],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------- outputs

export const WhoamiOutput = {
  type: "object",
  properties: {
    principalId: str,
    kind: { enum: ["human", "agent", "system"] },
    name: str,
    ownerId: nullableStr,
    scopes: { type: "array", items: str },
    canApprove: bool,
    repos: {
      type: "array",
      items: {
        type: "object",
        properties: { id: str, name: str, claim: Claim, actions: { type: "array", items: str } },
        required: ["id", "name", "claim", "actions"],
      },
    },
    quotas: {
      type: "object",
      properties: {
        enforced: bool,
        ciMinutesPerDay: { type: ["integer", "null"] },
        ciMinutesUsedToday: { type: ["integer", "null"] },
        artifactsOpsPerDay: { type: ["integer", "null"] },
      },
      required: ["enforced", "ciMinutesPerDay", "ciMinutesUsedToday", "artifactsOpsPerDay"],
    },
  },
  required: ["principalId", "kind", "name", "ownerId", "scopes", "canApprove", "repos", "quotas"],
} as const;

export const ListReposOutput = {
  type: "object",
  properties: {
    repos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: str,
          name: str,
          defaultBranch: str,
          lane0Enabled: bool,
          claim: Claim,
          counts: LaneCounts,
        },
        required: ["id", "name", "defaultBranch", "lane0Enabled", "claim", "counts"],
      },
    },
  },
  required: ["repos"],
} as const;

export const CreatePlanOutput = {
  type: "object",
  properties: {
    plan: {
      type: "object",
      properties: {
        id: str,
        repoId: str,
        title: str,
        status: { enum: ["draft", "approved", "superseded", "rejected"] },
        authorId: str,
        scopePaths: { type: "array", items: str },
        supersedes: nullableStr,
        createdAt: str,
      },
      required: [
        "id",
        "repoId",
        "title",
        "status",
        "authorId",
        "scopePaths",
        "supersedes",
        "createdAt",
      ],
    },
    nextSteps: NextSteps,
  },
  required: ["plan", "nextSteps"],
} as const;

export const StartChangeOutput = {
  type: "object",
  properties: { change: ChangeBrief, remote: GitRemote, nextSteps: NextSteps },
  required: ["change", "remote", "nextSteps"],
} as const;

export const ChangeStatusOutput = {
  type: "object",
  properties: {
    change: ChangeBrief,
    runs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: str,
          headSha: str,
          status: str,
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: { name: str, kind: str, status: str, logRef: nullableStr },
              required: ["name", "kind", "status", "logRef"],
            },
          },
        },
        required: ["id", "headSha", "status", "steps"],
      },
    },
    classification: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            lane,
            computedLane: lane,
            shadow: bool,
            blocked: bool,
            requiresHumanApproval: bool,
            reasons: { type: "array", items: LaneReason },
          },
          required: [
            "lane",
            "computedLane",
            "shadow",
            "blocked",
            "requiresHumanApproval",
            "reasons",
          ],
        },
      ],
    },
    nextSteps: NextSteps,
  },
  required: ["change", "runs", "classification", "nextSteps"],
} as const;

export const EvidenceOutput = {
  type: "object",
  properties: {
    changeId: str,
    headSha: str,
    verification: {
      type: "object",
      properties: { ok: bool, keyId: str, reason: str },
      required: ["ok"],
    },
    signedAt: str,
    keyId: str,
    items: {
      type: "array",
      items: {
        type: "object",
        description: "One signed evidence item; `kind`-specific fields are included as-is.",
        properties: { id: str, kind: str, status: { enum: ["ok", "skipped", "error"] }, note: str },
        required: ["id", "kind", "status"],
      },
    },
  },
  required: ["changeId", "headSha", "verification", "signedAt", "keyId", "items"],
} as const;

export const TourOutput = {
  type: "object",
  properties: {
    tour: {
      type: "object",
      properties: {
        id: str,
        headSha: str,
        stops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: str,
              title: str,
              why: str,
              verdict: { enum: ["proven", "unproven", "risk"] },
              hunkRefs: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    file: str,
                    startLine: int,
                    endLine: int,
                    side: { enum: ["head", "base"] },
                  },
                  required: ["file", "startLine", "endLine", "side"],
                },
              },
              evidenceRefs: { type: "array", items: str },
            },
            required: ["kind", "title", "why", "verdict", "hunkRefs", "evidenceRefs"],
          },
        },
        leastConfident: { type: "array", items: str },
        notDone: { type: "array", items: str },
      },
      required: ["id", "headSha", "stops", "leastConfident", "notDone"],
    },
  },
  required: ["tour"],
} as const;

export const RequestReviewOutput = {
  type: "object",
  properties: {
    changeId: str,
    status: { enum: CHANGE_STATUSES },
    notified: bool,
    nextSteps: NextSteps,
  },
  required: ["changeId", "status", "notified", "nextSteps"],
} as const;

export const IssuesOutput = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: str,
          title: str,
          count: int,
          firstSeen: str,
          lastSeen: str,
          versionId: nullableStr,
          url: nullableStr,
        },
        required: ["id", "title", "count", "firstSeen", "lastSeen", "versionId", "url"],
      },
    },
  },
  required: ["issues"],
} as const;

export const RefreshPushTokenOutput = {
  type: "object",
  properties: { remote: GitRemote },
  required: ["remote"],
} as const;

export const WaitForChangeOutput = {
  type: "object",
  properties: {
    reached: bool,
    reason: { enum: ["reached", "timeout", "unreachable"] },
    change: ChangeBrief,
    nextSteps: NextSteps,
  },
  required: ["reached", "reason", "change", "nextSteps"],
} as const;
