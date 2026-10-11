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
  description: "What to do next, as concrete tool calls (call) or shell commands (command).",
  items: {
    type: "object",
    properties: { title: str, call: str, command: str, why: str },
    required: ["title"],
  },
} as const;

/** Launch templates (must equal @app/conventions TEMPLATE_IDS; the platform tests check it). */
export const TEMPLATES = ["workers-api", "preact-app", "ts-library", "static-site"] as const;

const LaneReason = {
  type: "object",
  properties: { code: str, lane, message: str },
  required: ["code", "lane", "message"],
} as const;

/** The reasons that set the lane, first; passing checks only counted (@app/domain groupLaneReasons). */
const LaneSummary = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      properties: {
        lane,
        deciding: {
          type: "array",
          items: LaneReason,
          description: "The reasons that put the change in this lane (empty in Lane 0).",
        },
        passingCount: {
          type: "integer",
          minimum: 0,
          description: "Checks that passed (Lane 0 reasons); change.laneReasons lists them last.",
        },
      },
      required: ["lane", "deciding", "passingCount"],
    },
  ],
  description:
    "Why the change is in its lane, compact: the deciding reasons and how many checks passed. Null before a lane is set.",
} as const;

/** Pushes the fork received that graded nothing (@app/domain PushIssue), each with its fix. */
const PushIssues = {
  type: "array",
  description:
    "Pushes to the fork since its last graded push that graded nothing (another branch, a tag, nothing on top of the base). Non-empty: your work never reached CI; run fix.command.",
  items: {
    type: "object",
    properties: {
      kind: { enum: ["wrong-ref", "tag", "no-new-commits"] },
      ref: str,
      expectedRef: str,
      sha: str,
      at: str,
      why: str,
      fix: {
        type: "object",
        properties: { explanation: str, command: str, call: str },
        required: ["explanation"],
      },
    },
    required: ["kind", "ref", "expectedRef", "sha", "at", "why", "fix"],
  },
} as const;

export const ChangeBrief = {
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

/** Pages on the platform a person can open (absolute URLs). */
const changeUrl = {
  type: "string",
  description: "The change's page on the platform: hand it to the person who reviews it.",
} as const;
const planUrl = {
  type: "string",
  description: "The plan's page on the platform: hand it to the person who approves it.",
} as const;

/**
 * Why wait_for_change answered. Must cover @app/coordinator's WaitReason: the platform's backend
 * returns the coordinator's answer as `WaitReasonData`, so its typecheck fails on a missing one.
 */
export const WAIT_REASONS = [
  "reached",
  "timeout",
  "unreachable",
  "changes-requested",
  "rejected",
  "approval-withdrawn",
  "superseded",
  "failing",
] as const;

const Review = {
  type: "object",
  description: "A human review; it binds to one head (current: the change's head now).",
  properties: {
    id: str,
    decision: { enum: ["approve", "request-changes", "reject"] },
    comment: nullableStr,
    headSha: str,
    current: bool,
    reviewer: {
      type: "object",
      properties: {
        id: str,
        name: str,
        kind: { enum: ["human", "agent", "system", "integration"] },
      },
      required: ["id", "name", "kind"],
    },
    at: str,
    withdrawn: { type: "boolean", description: "The approval no longer counts." },
    withdrawnReason: { ...nullableStr, description: 'Why it was withdrawn (e.g. "qa-failed").' },
  },
  required: [
    "id",
    "decision",
    "comment",
    "headSha",
    "current",
    "reviewer",
    "at",
    "withdrawn",
    "withdrawnReason",
  ],
} as const;

/** Who is accountable: a principal, with an agent's owner. */
const Person = {
  type: "object",
  properties: {
    id: str,
    name: str,
    kind: { enum: ["human", "agent", "system", "integration"] },
    ownerId: nullableStr,
    ownerName: { ...nullableStr, description: "For an agent: the person accountable for it." },
  },
  required: ["id", "name", "kind", "ownerId", "ownerName"],
} as const;

/** The merge queue's conflict resolution: what lands instead of the head the author pushed. */
export const Resolution = {
  type: ["object", "null"],
  description:
    "Set when the merge queue resolved a conflict: what lands is headSha (the resolver's commit), not the head you pushed. null: no resolution.",
  properties: {
    headSha: {
      type: "string",
      description: "The resolved head: what lands on the default branch.",
    },
    originalHeadSha: { ...nullableStr, description: "The head you pushed." },
    kind: { enum: ["textual", "semantic"] },
    at: str,
    files: { type: "array", items: str, description: "Files with resolved conflict hunks." },
    upstream: {
      type: "array",
      description: "The changes it was resolved against.",
      items: {
        type: "object",
        properties: { changeId: str, title: nullableStr },
        required: ["changeId", "title"],
      },
    },
    approvalRequested: {
      type: "boolean",
      description: "The resolution invalidated the approval: a person must approve what lands.",
    },
  },
  required: ["headSha", "originalHeadSha", "kind", "at", "files", "upstream", "approvalRequested"],
} as const;

const GitRemote = {
  type: "object",
  description:
    "Push token for the change's fork only. Short-lived; refresh with refresh_push_token.",
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

/** GitHub mode: a pull request as `owner/repo#123`, in place of `changeId`. */
export const GITHUB_REF_PATTERN =
  "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}#[0-9]{1,9}$";
const githubRef = {
  type: "string",
  pattern: GITHUB_REF_PATTERN,
  description:
    "GitHub mode: the pull request as owner/repo#123, instead of changeId (pass exactly one).",
} as const;

/** A change by id, or (GitHub mode) by pull request. */
export const ChangeRefInput = {
  type: "object",
  properties: { changeId: id, github: githubRef },
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
    paths: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 300 },
      description:
        "Optional. Paths or globs you expect to touch (files like src/money.ts, or globs). The result's overlaps lists open changes already touching them, and until you push, agents starting later are told you intend to touch them. Never a lane input.",
    },
    idempotencyKey: {
      ...idempotencyKey,
      description:
        "Optional. Retrying with the same key returns the same change with a fresh push token.",
    },
  },
  required: ["repoId", "title", "category"],
  additionalProperties: false,
} as const;

export const CreateProjectInput = {
  type: "object",
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 63,
      description:
        "Repo name, normalized to lowercase letters, digits and dashes. Default: <template>-<random>.",
    },
    template: {
      enum: TEMPLATES,
      description:
        "Start from a template that passes CI and serves a preview at once. Omit both template and from for an empty repo.",
    },
    from: {
      type: "string",
      minLength: 9,
      maxLength: 500,
      pattern: "^https://",
      description: "Import a public https git repository (e.g. GitHub) instead of a template.",
    },
    importMode: {
      enum: ["push"],
      description:
        'Private repos: "push" creates an empty repo whose HUMAN owner pushes the history with a one-time grant. Humans only (an agent gets human-required: ask your human to create it signed in).',
    },
    description: { type: "string", maxLength: 500, description: "One line about the repo." },
    idempotencyKey,
  },
  additionalProperties: false,
} as const;

export const RequestReviewInput = {
  type: "object",
  properties: { changeId: id, message: { type: "string", maxLength: 2000 }, idempotencyKey },
  required: ["changeId"],
  additionalProperties: false,
} as const;

const reason = {
  type: "string",
  maxLength: 2000,
  description: "Why (recorded in the change's audit log).",
} as const;

export const RerunCiInput = {
  type: "object",
  properties: { changeId: id, reason, idempotencyKey },
  required: ["changeId"],
  additionalProperties: false,
} as const;

export const CloseChangeInput = {
  type: "object",
  properties: { changeId: id, reason, idempotencyKey },
  required: ["changeId"],
  additionalProperties: false,
} as const;

export const RefreshPushTokenInput = {
  type: "object",
  properties: { changeId: id },
  required: ["changeId"],
  additionalProperties: false,
} as const;

export const WaitForChangeInput = {
  type: "object",
  properties: {
    changeId: id,
    github: githubRef,
    until: { enum: WAIT_UNTIL },
    timeoutSec: {
      type: "integer",
      minimum: 1,
      maximum: 600,
      description:
        "Default 50. Keep it below your MCP client's request timeout (60s in the SDK default) and call again if not reached.",
    },
  },
  required: ["until"],
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
    ownerName: {
      ...nullableStr,
      description: "The person accountable for you (an agent's owner); null for a person.",
    },
    agentsUrl: {
      type: "string",
      description: "The page where your person inspects or revokes you (their agents).",
    },
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
    nextSteps: NextSteps,
  },
  required: [
    "principalId",
    "kind",
    "name",
    "ownerId",
    "ownerName",
    "agentsUrl",
    "scopes",
    "canApprove",
    "repos",
    "quotas",
    "nextSteps",
  ],
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

export const RepoIdInput = {
  type: "object",
  properties: { repoId: id },
  required: ["repoId"],
  additionalProperties: false,
} as const;

const RepoRole = { type: "string", enum: ["owner", "maintainer", "reviewer", "reader"] } as const;

export const ListMembersOutput = {
  type: "object",
  properties: {
    repoId: str,
    members: {
      type: "array",
      items: {
        type: "object",
        properties: { principalId: str, name: str, role: RepoRole, addedAt: str },
        required: ["principalId", "name", "role", "addedAt"],
      },
    },
    yourRole: {
      type: ["string", "null"],
      enum: ["owner", "maintainer", "reviewer", "reader", null],
    },
  },
  required: ["repoId", "members", "yourRole"],
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
    url: planUrl,
    nextSteps: NextSteps,
  },
  required: ["plan", "url", "nextSteps"],
} as const;

export const CreateProjectOutput = {
  type: "object",
  properties: {
    repoId: { ...str, description: "The repo id: pass it as repoId to every other tool." },
    projectId: {
      ...str,
      description: "Deprecated: the same value as repoId, kept for older clients.",
    },
    name: str,
    template: nullableStr,
    defaultBranch: str,
    remote: {
      description:
        "Push token for your first Change's fork (changeId), at the initial commit: clone or push there right away. Null if the fork could not be made; call start_change.",
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            url: str,
            username: str,
            token: str,
            expiresAt: str,
            branch: str,
            changeId: str,
          },
          required: ["url", "username", "token", "expiresAt", "branch", "changeId"],
        },
      ],
    },
    token: {
      ...nullableStr,
      description:
        "Bearer token for this repo when you called without credentials (unclaimed repos); null when you are already authenticated. Reconnect with Authorization: Bearer <token> before any other call.",
    },
    mcpUrl: str,
    previewUrl: {
      ...nullableStr,
      description:
        "Live preview of the main branch (serves a 'building' page until the first CI run is green). Null when the repo has nothing to preview.",
    },
    claimUrl: nullableStr,
    bootstrapChangeId: {
      ...nullableStr,
      description: "The Change running the first CI and preview: wait_for_change on it.",
    },
    nextSteps: NextSteps,
  },
  required: [
    "projectId",
    "name",
    "template",
    "defaultBranch",
    "remote",
    "token",
    "mcpUrl",
    "previewUrl",
    "claimUrl",
    "bootstrapChangeId",
    "nextSteps",
  ],
} as const;

const OverlapReason = {
  type: "object",
  properties: {
    code: { enum: ["same-plan", "same-paths", "paths-unknown"] },
    message: str,
    paths: {
      type: "array",
      items: str,
      description: "same-paths: the overlapping paths (capped).",
    },
    morePaths: { ...int, description: "same-paths: overlapping paths not listed." },
  },
  required: ["code", "message", "paths", "morePaths"],
} as const;

const ChangeOverlap = {
  type: "object",
  description: "Another open change in the repo on the same plan or paths.",
  properties: {
    changeId: str,
    title: str,
    status: { enum: CHANGE_STATUSES },
    lane: laneOrNull,
    headSha: nullableStr,
    planId: nullableStr,
    author: {
      type: "object",
      properties: {
        id: str,
        kind: { enum: ["human", "agent", "system", "integration"] },
        name: str,
      },
      required: ["id", "kind", "name"],
    },
    reasons: { type: "array", items: OverlapReason },
    pathsKnown: {
      ...bool,
      description:
        "False: it has nothing pushed and declared no paths, so whether its paths overlap is unknown.",
    },
    pathsFrom: {
      enum: ["head", "intended", null],
      description:
        "head: its pushed diff; intended: the paths it gave start_change (nothing pushed yet).",
    },
    url: { ...str, description: "Its page on the platform." },
  },
  required: [
    "changeId",
    "title",
    "status",
    "lane",
    "headSha",
    "planId",
    "author",
    "reasons",
    "pathsKnown",
    "pathsFrom",
    "url",
  ],
} as const;

/** Open changes on the same plan or paths; null when the check could not run (ask again). */
const Overlaps = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      description:
        "Open changes (not merged, rejected or abandoned) in the repo on the same plan or touching the same paths. Coordinate with their authors or wait for them to merge before touching the same paths.",
      properties: {
        overlaps: { type: "array", items: ChangeOverlap },
        moreOverlaps: int,
        comparedPaths: {
          type: "array",
          items: str,
          description:
            "What this change was compared on: its paths, its diff, or its plan's scopePaths.",
        },
        scanned: { ...int, description: "Open changes looked at (the newest)." },
        truncated: { ...bool, description: "More open changes exist than were scanned." },
        unchecked: {
          type: "array",
          items: str,
          description:
            "Open changes whose overlap by path is unknown (either side has no paths yet): check again after pushing.",
        },
      },
      required: ["overlaps", "moreOverlaps", "comparedPaths", "scanned", "truncated", "unchecked"],
    },
  ],
} as const;

export const StartChangeOutput = {
  type: "object",
  properties: {
    change: ChangeBrief,
    remote: GitRemote,
    url: changeUrl,
    overlaps: Overlaps,
    nextSteps: NextSteps,
  },
  required: ["change", "remote", "url", "overlaps", "nextSteps"],
} as const;

export const ChangeStatusOutput = {
  type: "object",
  properties: {
    change: ChangeBrief,
    url: changeUrl,
    author: {
      ...Person,
      description: "Who started the change, and for an agent the person accountable.",
    },
    resolution: Resolution,
    reviews: {
      type: "array",
      items: Review,
      description:
        "Human reviews of every head, oldest first. After changes were requested, the newest current one says what to fix.",
    },
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
    previewUrl: {
      type: ["string", "null"],
      description:
        "The live preview of the current head once it answers (null before that, or when the repo has no preview).",
    },
    overlaps: Overlaps,
    supersededBy: {
      type: ["string", "null"],
      description:
        "Several agents attempted this change's plan and a person picked this other change, which closed this one (null: not superseded).",
    },
    laneSummary: LaneSummary,
    pushIssues: PushIssues,
    nextSteps: NextSteps,
  },
  required: [
    "change",
    "url",
    "author",
    "resolution",
    "reviews",
    "runs",
    "classification",
    "previewUrl",
    "overlaps",
    "laneSummary",
    "pushIssues",
    "nextSteps",
  ],
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
    url: { type: "string", description: "The change's evidence page, to hand a person." },
    nextSteps: NextSteps,
  },
  required: [
    "changeId",
    "headSha",
    "verification",
    "signedAt",
    "keyId",
    "items",
    "url",
    "nextSteps",
  ],
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
    stale: {
      type: "boolean",
      description:
        "True when the walkthrough was written for an older head; a new one follows the latest push.",
    },
    url: changeUrl,
    nextSteps: NextSteps,
  },
  required: ["tour", "stale", "url", "nextSteps"],
} as const;

export const RequestReviewOutput = {
  type: "object",
  properties: {
    changeId: str,
    status: { enum: CHANGE_STATUSES },
    requested: {
      type: "boolean",
      description:
        "The request is recorded (audit log, the dashboard's agent band). Nobody receives a message: hand url to a person.",
    },
    url: changeUrl,
    nextSteps: NextSteps,
  },
  required: ["changeId", "status", "requested", "url", "nextSteps"],
} as const;

export const RerunCiOutput = {
  type: "object",
  properties: {
    change: ChangeBrief,
    headSha: { type: "string", description: "The head CI runs on again (unchanged)." },
    nextSteps: NextSteps,
  },
  required: ["change", "headSha", "nextSteps"],
} as const;

export const CloseChangeOutput = {
  type: "object",
  properties: { change: ChangeBrief, url: changeUrl, nextSteps: NextSteps },
  required: ["change", "url", "nextSteps"],
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
    reached: {
      type: "boolean",
      description:
        "True when the milestone holds for the change's current head at the moment of this answer (each milestone is defined in the tool description).",
    },
    reason: {
      enum: WAIT_REASONS,
      description:
        "reached; timeout (call again); unreachable (the change ended); a human sent it back first: changes-requested (push a new head), rejected (it ended), approval-withdrawn (it needs a fresh review); the machines did (merged/reverted waits): failing (red CI, a merge-queue ejection or a failed merge: read get_change_status, fix and push a new head); or superseded (a person picked another attempt at the same plan and this change was closed: supersededBy).",
    },
    supersededBy: {
      type: "string",
      description: 'With reason "superseded": the change a person picked instead.',
    },
    retryAfterSec: {
      type: "integer",
      minimum: 0,
      description:
        'With reason "timeout": call again after this many seconds (0: right away; more when the platform was interrupted, e.g. by a deploy).',
    },
    change: ChangeBrief,
    url: changeUrl,
    laneSummary: LaneSummary,
    pushIssues: PushIssues,
    warning: {
      type: "string",
      description:
        "Set when something needs you rather than more waiting, e.g. a timeout while your pushes went to the wrong ref (see pushIssues).",
    },
    nextSteps: NextSteps,
  },
  required: ["reached", "reason", "change", "url", "laneSummary", "pushIssues", "nextSteps"],
} as const;
