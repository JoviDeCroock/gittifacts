/**
 * `createCoordinator`: the CoordinatorApi facade. It enforces the lifecycle rules (who may review,
 * no self-approval, reviews bind to a head, Lane 0 needs shadow agreement, unclaimed projects
 * never auto-merge, …) and hands durable work to the ChangeCoordinator DO, the MergeQueue DO and
 * the Workflows. Every error carries a `fix` telling the caller what to do next.
 */
import { shadowAgreement } from "@app/classifier";
import {
  type Change,
  defaultPolicy,
  type ErrorFix,
  type Jurisdiction,
  type Lane,
  type Principal,
  type Repo,
  type ReviewDecision,
  StartChangeInput,
  WaitUntil,
} from "@app/domain";
import { z } from "zod";
import { recordHostReview } from "./host-review.js";
import {
  type CoordinatorApi,
  CoordinatorError,
  type CoordinatorErrorCode,
  type GitRemoteGrant,
  type InitialCommitProvider,
} from "./api.js";
import { type CoordinatorBindings, type MergeQueueClient, terminateQuietly } from "./bindings.js";
import { EVENT_ISSUE, EVENT_REVIEW, type ReviewEvent } from "./events.js";
import {
  bootstrapChangeIdFor,
  changeSubject,
  changeWorkflowId,
  FORK_PREFIX,
  forkNameFor,
  isBootstrapChange,
  isForkName,
  newId,
  QUEUE_SCRATCH_PREFIX,
  repoSubject,
  rolloutWorkflowId,
  SEED_PREFIX,
  ZERO_SHA,
} from "./ids.js";
import { framesOf, normalizeIssue } from "./issues.js";
import { FINAL_STATUSES, KILLABLE_STATUSES, PUSHABLE_STATUSES } from "./lifecycle.js";
import { changeVersion, clampWait, withChangeNotifications } from "./milestones.js";
import { errorMessage, parsePolicyExport, resolvePolicy } from "./policy.js";
import { type Ports, type RepoNeed, SYSTEM_PRINCIPAL_ID } from "./ports.js";
import { ensureProjectFlagApp } from "./project-flags.js";
import { openRevertChange } from "./revert.js";

export interface CoordinatorOptions {
  /** Jurisdiction recorded on new repos (must match the GitHost's namespace). Default "eu". */
  jurisdiction?: Jurisdiction;
  newId?: () => string;
  /** Push token TTL for change forks; capped at 3600. */
  pushTokenTtlSeconds?: number;
  /** Delay before an abandoned change's fork is deleted. */
  forkGcDelayMs?: number;
  /** Unclaimed projects expire after this long unless claimed (default 7 days). */
  unclaimedTtlMs?: number;
  /** How long an idempotency key is remembered (default 24 h). */
  idempotencyTtlMs?: number;
  /** Files of a new repo's initial commit. Without it, `createRepo` creates an empty repo. */
  initialCommit?: InitialCommitProvider;
  /**
   * A review of a change whose host merges it (GitHub mode) was recorded: the platform refreshes
   * what the host shows (the PR's summary comment). Best effort; never fails the review.
   */
  onHostReview?: (change: Change, review: ReviewDecision) => Promise<void>;
  /** GitHub mode: is this principal the PR's author on the host (a linked GitHub login)? */
  isHostAuthor?: (change: Change, principalId: string) => Promise<boolean>;
}

const MAX_PUSH_TTL = 3600;
/** Artifacts naming: 2-63 chars, starts with a letter or digit; letters, digits, ".", "_", "-". */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;
const IdempotencyKey = z.string().min(1).max(200);

const CreateRepoInput = z.object({
  name: z
    .string()
    .regex(
      REPO_NAME,
      "2-63 chars: letters, digits, '.', '_', '-'; must start with a letter or digit",
    ),
  defaultBranch: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/)
    .refine((b) => !b.includes(".."), "invalid branch name")
    .default("main"),
  template: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  /** No initial commit: the default branch arrives with the owner's push (import by push). */
  empty: z.boolean().optional(),
});
const ImportRepoInput = z.object({
  name: CreateRepoInput.shape.name,
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), "only public https:// remotes can be imported"),
  branch: z.string().min(1).max(100).optional(),
});
const StartInput = StartChangeInput.extend({ idempotencyKey: IdempotencyKey.optional() });
const ReviewInput = z.object({
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  decision: z.enum(["approve", "request-changes", "reject"]),
  humanLane: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  comment: z.string().max(10_000).optional(),
  idempotencyKey: IdempotencyKey.optional(),
});

const status = (changeId: string) => `get_change_status({ changeId: "${changeId}" })`;

function fail(code: CoordinatorErrorCode, message: string, fix: ErrorFix | string): never {
  throw new CoordinatorError(code, message, fix);
}

function parse<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const msg = r.error.issues
      .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
      .join("; ");
    fail("invalid-input", msg, `Fix the ${what} fields listed in the message and retry.`);
  }
  return r.data;
}

/** Wrap a port call: anything that is not already a CoordinatorError becomes "upstream". */
async function upstream<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CoordinatorError) throw e;
    throw new CoordinatorError("upstream", `${what}: ${errorMessage(e)}`, {
      explanation: `A platform dependency failed while trying to ${what}. It is safe to retry with the same idempotency key.`,
    });
  }
}

/** Deterministic 20-char id from parts (idempotent creates). */
async function derivedId(...parts: string[]): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000"))),
  );
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 20; i++) out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  return out;
}

/** Who owns a repo created by `actor`: humans own theirs, agents' owners own theirs, otherwise unclaimed. */
function claimFor(actor: Principal, now: Date, ttlMs: number): Repo["claim"] {
  if (actor.kind === "human") return { status: "claimed", ownerId: actor.id, expiresAt: null };
  if (actor.kind === "agent" && actor.ownerId !== null)
    return { status: "claimed", ownerId: actor.ownerId, expiresAt: null };
  return {
    status: "unclaimed",
    ownerId: null,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

export function createCoordinator(
  rawPorts: Ports,
  bindings: CoordinatorBindings,
  options: CoordinatorOptions = {},
): CoordinatorApi {
  // Every change-row update also wakes `waitFor` long-polls on the change's DO.
  const ports = withChangeNotifications(rawPorts, bindings);
  const { store, git, audit, clock } = ports;
  const makeId = options.newId ?? newId;
  const jurisdiction = options.jurisdiction ?? "eu";
  const pushTtl = Math.min(options.pushTokenTtlSeconds ?? MAX_PUSH_TTL, MAX_PUSH_TTL);
  const forkGcDelayMs = options.forkGcDelayMs ?? 10 * 60_000;
  const unclaimedTtlMs = options.unclaimedTtlMs ?? 7 * 24 * 60 * 60_000;
  const idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60_000;
  const now = () => clock.now().toISOString();

  async function requireRepo(id: string): Promise<Repo> {
    return (
      (await store.getRepo(id)) ??
      fail("not-found", `repo ${id} not found`, "Check the repo id; list your repos to find it.")
    );
  }

  async function requireChange(id: string): Promise<Change> {
    return (
      (await store.getChange(id)) ??
      fail("not-found", `change ${id} not found`, {
        explanation: "Check the change id.",
        call: status(id),
      })
    );
  }

  async function pushGrant(
    change: Pick<Change, "forkName">,
    branch: string,
  ): Promise<GitRemoteGrant> {
    // The token is for the fork ONLY; agents never get a token for the main repo.
    if (!isForkName(change.forkName))
      fail("forbidden", "push grants are for change forks only", "Push to your change's fork.");
    const { token, expiresAt } = await upstream("mint a push token", () =>
      git.mintToken(change.forkName, "write", pushTtl),
    );
    return { url: git.remoteOf(change.forkName), username: "x", token, expiresAt, branch };
  }

  async function assertNameFree(name: string): Promise<void> {
    for (const [prefix, what] of [
      [FORK_PREFIX, "change forks"],
      [SEED_PREFIX, "the platform's template caches"],
      [QUEUE_SCRATCH_PREFIX, "the merge queue's scratch repos"],
    ] as const) {
      if (name.startsWith(prefix)) {
        fail(
          "invalid-input",
          `repo names may not start with "${prefix}"`,
          `Pick a name that does not start with "${prefix}" (reserved for ${what}).`,
        );
      }
    }
    if ((await store.getRepoByArtifactsName(name)) !== null) {
      fail(
        "conflict",
        `a repo named ${name} already exists`,
        "Pick another name, or open a change on the existing repo.",
      );
    }
  }

  const NEED_TEXT: Record<RepoNeed, string> = {
    read: "read it",
    contribute: "draft plans or start and push changes in it",
    review: "review its changes",
    approve: "approve its plans or pull its kill switch",
    admin: "administer it",
  };

  /**
   * Repo membership (the `access` port): `hidden` answers exactly like a missing repo or change,
   * `denied` is forbidden. The system principal and facades without the port skip it.
   */
  async function assertAccess(
    actor: Principal,
    repoId: string,
    need: RepoNeed,
    hidden: () => never,
  ): Promise<void> {
    if (ports.access === undefined || actor.id === SYSTEM_PRINCIPAL_ID) return;
    const r = await ports.access.check(actor, repoId, need);
    if (r === "allowed") return;
    if (r === "hidden") hidden();
    fail("forbidden", `${actor.name} may not ${NEED_TEXT[need]} (repo ${repoId})`, {
      explanation:
        "Your role on this repo (an agent: its owner's role) does not allow this. Roles are reader < reviewer < maintainer < owner; ask an owner of the repo.",
      call: `list_members({ repoId: "${repoId}" })`,
    });
  }

  const noRepo = (id: string) => (): never =>
    fail("not-found", `repo ${id} not found`, "Check the repo id; list your repos to find it.");
  const noChange = (id: string) => (): never =>
    fail("not-found", `change ${id} not found`, {
      explanation: "Check the change id.",
      call: status(id),
    });

  function canActOnChange(actor: Principal, change: Change, author: Principal | null): boolean {
    if (actor.id === change.authorId) return true;
    if (author?.kind === "agent" && author.ownerId === actor.id) return true;
    return actor.kind === "human" && actor.scopes.includes("change:review");
  }

  async function grantFor(change: Change): Promise<GitRemoteGrant> {
    const repo = await requireRepo(change.repoId);
    return pushGrant(change, repo.defaultBranch);
  }

  const api: CoordinatorApi = {
    async createRepo(actor, input) {
      const { name, defaultBranch, template, description, idempotencyKey, empty } = parse(
        CreateRepoInput,
        input,
        "repo",
      );
      if (empty === true && template !== undefined) {
        fail("invalid-input", "an empty repo has no template", "Pass template or empty, not both.");
      }
      // Idempotent: the same (actor, key) always names the same repo.
      const id =
        idempotencyKey === undefined ? makeId() : await derivedId("repo", actor.id, idempotencyKey);
      if (idempotencyKey !== undefined) {
        const existing = await store.getRepo(id);
        if (existing !== null) {
          if (existing.artifactsName !== name) {
            fail(
              "conflict",
              "idempotency key already used for another repo",
              "Use a fresh idempotency key for a new repo.",
            );
          }
          return existing;
        }
      }
      await assertNameFree(name);
      const claim = claimFor(actor, clock.now(), unclaimedTtlMs);
      // Before anything exists, so an unknown template fails without side effects.
      const initial =
        options.initialCommit === undefined || empty === true
          ? null
          : await options.initialCommit({
              repoId: id,
              name,
              defaultBranch,
              template: template ?? null,
              description: description ?? null,
              claimed: claim.status === "claimed",
            });
      await upstream("create the repo", async () => {
        try {
          await git.createRepo(name, {
            defaultBranch,
            ...(description === undefined ? {} : { description }),
          });
        } catch (e) {
          // A retry after a partial failure finds its own empty repo (the row above is still
          // free): adopt it. Anything with history is someone else's.
          const exists =
            (e as { code?: unknown }).code === "ALREADY_EXISTS" ||
            /ALREADY_EXISTS/.test(errorMessage(e));
          if (!exists || (await git.branchHead(name, defaultBranch)) !== null) throw e;
        }
      });
      let initialSha: string | null = null;
      let policy = defaultPolicy();
      let policySha: string | null = null;
      if (initial !== null) {
        const written = await upstream("write the initial commit", () =>
          git.writeInitialCommit(name, {
            branch: defaultBranch,
            files: initial.files,
            message: initial.message,
          }),
        );
        initialSha = written.sha;
        if (initial.policy !== undefined) {
          // The generated policy file, parsed like the sandbox's evaluation would be.
          const parsed = parsePolicyExport(initial.policy, false);
          if (!("error" in parsed)) {
            policy = parsed.policy;
            policySha = initialSha;
          }
        }
      }
      const repo: Repo = {
        id,
        namespace: git.namespace,
        artifactsName: name,
        name,
        defaultBranch,
        jurisdiction,
        importedFrom: null,
        policy,
        policySha,
        deployTarget: null,
        claim,
        template: template ?? null,
        createdAt: now(),
      };
      await store.insertRepo(repo);
      await audit.append({
        principalId: actor.id,
        action: "repo.created",
        subject: repoSubject(repo.id),
        payload: {
          name,
          defaultBranch,
          namespace: repo.namespace,
          claim: repo.claim,
          template: repo.template,
          initialSha,
          files: initial === null ? 0 : Object.keys(initial.files).length,
        },
      });
      return repo;
    },

    async startBootstrapChange(actor, repoId) {
      const repo = await requireRepo(repoId);
      const owner = repo.claim.ownerId;
      const allowed =
        actor.id === SYSTEM_PRINCIPAL_ID ||
        (owner === null
          ? actor.scopes.includes("change:create")
          : actor.id === owner || (actor.kind === "agent" && actor.ownerId === owner));
      if (allowed) await assertAccess(actor, repo.id, "contribute", noRepo(repo.id));
      if (!allowed) {
        fail("forbidden", "only the repo's owner (or its agents) can bootstrap it", {
          explanation: "The bootstrap Change runs once, when the project is created.",
          call: `get_change_status({ changeId: "${bootstrapChangeIdFor(repo.id)}" })`,
        });
      }
      const id = bootstrapChangeIdFor(repo.id);
      let change = await store.getChange(id);
      if (change === null) {
        const head = await upstream("read the default branch", () =>
          git.branchHead(repo.artifactsName, repo.defaultBranch),
        );
        if (head === null) {
          fail(
            "invalid-state",
            `${repo.name} has no commits on ${repo.defaultBranch}`,
            "Create the project from a template (or push an initial commit) first.",
          );
        }
        const createdAt = now();
        const fresh: Change = {
          id,
          repoId: repo.id,
          planId: null,
          title: "Bootstrap: first CI run and preview",
          claim: { category: "chore", summary: null },
          baseSha: head,
          headSha: head,
          // No fork: CI checks out the main repo's initial commit (read token only).
          forkName: repo.artifactsName,
          authorId: SYSTEM_PRINCIPAL_ID,
          status: "running",
          computedLane: null,
          lane: null,
          laneReasons: [],
          evidenceId: null,
          tourId: null,
          flagKey: null,
          mergedSha: null,
          rolloutState: null,
          revertOf: null,
          revertedBy: null,
          agentTraceId: null,
          createdAt,
          updatedAt: createdAt,
        };
        try {
          await store.insertChange(fresh);
          change = fresh;
          await audit.append({
            principalId: actor.id,
            action: "change.bootstrap-started",
            subject: changeSubject(id),
            payload: { repoId: repo.id, headSha: head },
          });
        } catch (e) {
          change = await store.getChange(id);
          if (change === null) throw e;
        }
      }
      if (change.status === "running" && change.headSha !== null) {
        // Idempotent: a retry after a failed start (or a lost race) starts the same instance.
        const headSha = change.headSha;
        await upstream("start the bootstrap pipeline", () =>
          bindings.changeCoordinator(id).startBootstrap({ changeId: id, headSha }),
        );
      }
      return change;
    },

    async importRepo(actor, input) {
      const { name, url, branch } = parse(ImportRepoInput, input, "import");
      await assertNameFree(name);
      const imported = await upstream("import the repo", () =>
        git.importRepo(name, url, branch === undefined ? {} : { branch }),
      );
      const claim = claimFor(actor, clock.now(), unclaimedTtlMs);
      const head = await upstream("read the default branch", () =>
        git.branchHead(name, imported.defaultBranch),
      );
      const resolved =
        head === null
          ? { policy: defaultPolicy(), source: "default" as const, error: null }
          : await resolvePolicy(ports, {
              repo: null,
              claim: claim.status,
              repoName: name,
              sha: head,
            });
      const repo: Repo = {
        id: makeId(),
        namespace: git.namespace,
        artifactsName: name,
        name,
        defaultBranch: imported.defaultBranch,
        jurisdiction,
        importedFrom: url,
        policy: resolved.policy,
        // An unreadable policy is not cached: every change re-evaluates it (and escalates).
        policySha: head !== null && resolved.source !== "unavailable" ? head : null,
        deployTarget: null,
        claim,
        template: null,
        createdAt: now(),
      };
      await store.insertRepo(repo);
      await audit.append({
        principalId: actor.id,
        action: "repo.imported",
        subject: repoSubject(repo.id),
        payload: {
          name,
          url,
          defaultBranch: repo.defaultBranch,
          head,
          policy: resolved.source,
          policyError: resolved.error,
          claim,
        },
      });
      return repo;
    },

    async startChange(actor, input) {
      const parsed = parse(StartInput, input, "change");
      const repo = await requireRepo(parsed.repoId);
      await assertAccess(actor, repo.id, "contribute", noRepo(repo.id));
      // Idempotent: the same (actor, key) always names the same change.
      const id =
        parsed.idempotencyKey === undefined
          ? makeId()
          : await derivedId("change", actor.id, parsed.idempotencyKey);
      const existing = parsed.idempotencyKey === undefined ? null : await store.getChange(id);
      if (existing !== null) {
        if (existing.authorId !== actor.id || existing.repoId !== repo.id) {
          fail(
            "conflict",
            "idempotency key already used for another change",
            "Use a fresh idempotency key for a new change.",
          );
        }
        return { change: existing, remote: await grantFor(existing) };
      }
      if (parsed.planId !== undefined) {
        const plan = await store.getPlan(parsed.planId);
        if (plan === null)
          fail(
            "not-found",
            `plan ${parsed.planId} not found`,
            "Create a plan first with create_plan, then pass its id.",
          );
        if (plan.repoId !== repo.id)
          fail(
            "invalid-input",
            "plan belongs to another repo",
            "Pass a plan created for this repo.",
          );
        if (plan.status === "rejected" || plan.status === "superseded") {
          fail("invalid-state", `plan ${plan.id} is ${plan.status}`, {
            explanation: "Start the change from the plan's current approved version.",
            call: `create_plan({ repoId: "${repo.id}", supersedes: "${plan.id}" })`,
          });
        }
      }
      const baseSha = await upstream("read the default branch", () =>
        git.branchHead(repo.artifactsName, repo.defaultBranch),
      );
      if (baseSha === null) {
        fail(
          "invalid-state",
          `${repo.name} has no commits on ${repo.defaultBranch}`,
          "Push an initial commit (or create the repo from a template) before starting a change.",
        );
      }
      const forkName = forkNameFor(id);
      await upstream("fork the repo", () => git.forkRepo(repo.artifactsName, forkName));
      const createdAt = now();
      const change: Change = {
        id,
        repoId: repo.id,
        planId: parsed.planId ?? null,
        title: parsed.title,
        claim: { category: parsed.category, summary: parsed.summary ?? null },
        baseSha,
        headSha: null,
        forkName,
        authorId: actor.id,
        status: "awaiting-push",
        computedLane: null,
        lane: null,
        laneReasons: [],
        evidenceId: null,
        tourId: null,
        flagKey: null,
        mergedSha: null,
        rolloutState: null,
        revertOf: null,
        revertedBy: null,
        agentTraceId: parsed.agentTraceId ?? null,
        createdAt,
        updatedAt: createdAt,
      };
      try {
        await store.insertChange(change);
      } catch (e) {
        // A concurrent retry with the same key won the insert: return its change.
        const raced = await store.getChange(id);
        if (raced === null || raced.authorId !== actor.id) throw e;
        return { change: raced, remote: await grantFor(raced) };
      }
      const remote = await pushGrant(change, repo.defaultBranch);
      await audit.append({
        principalId: actor.id,
        action: "change.started",
        subject: changeSubject(id),
        payload: {
          repoId: repo.id,
          planId: change.planId,
          baseSha,
          forkName,
          category: parsed.category,
          tokenExpiresAt: remote.expiresAt,
        },
      });
      return { change, remote };
    },

    async refreshPushGrant(actor, changeId) {
      const change = await requireChange(changeId);
      await assertAccess(actor, change.repoId, "contribute", noChange(changeId));
      if (actor.id !== change.authorId) {
        fail("forbidden", "only the change's author can push to its fork", {
          explanation: "Start your own change instead of pushing to someone else's fork.",
          call: `start_change({ repoId: "${change.repoId}" })`,
        });
      }
      if (!PUSHABLE_STATUSES.includes(change.status)) {
        fail("invalid-state", `change is ${change.status}; it no longer accepts pushes`, {
          explanation: "Start a new change for further work.",
          call: `start_change({ repoId: "${change.repoId}" })`,
        });
      }
      const grant = await grantFor(change);
      await audit.append({
        principalId: actor.id,
        action: "change.push-grant-refreshed",
        subject: changeSubject(changeId),
        payload: { forkName: change.forkName, expiresAt: grant.expiresAt },
      });
      return grant;
    },

    async onPush(event) {
      if (!isForkName(event.repoName)) return; // only change forks are routed
      if (!event.ref.startsWith("refs/heads/") || event.after === ZERO_SHA) return;
      const change = await store.getChangeByFork(event.repoName);
      if (change === null) return;
      await bindings.changeCoordinator(change.id).onPush({
        changeId: change.id,
        ref: event.ref,
        before: event.before,
        after: event.after,
      });
    },

    async submitReview(actor, changeId, input) {
      const review = parse(ReviewInput, input, "review");
      const change = await requireChange(changeId);
      // Members (reviewer or above) only; nobody reviews an unclaimed project before its claim.
      if (actor.kind === "human")
        await assertAccess(actor, change.repoId, "review", noChange(changeId));
      if (actor.kind !== "human") {
        fail("forbidden", "only humans review changes; agents prove conformance", {
          explanation:
            "Ask a human reviewer to look at the tour; agents can never approve a change.",
          call: status(changeId),
        });
      }
      if (actor.id === change.authorId) {
        fail("self-approval", "no principal reviews its own change", {
          explanation: "Ask another human with change:review to review it.",
          call: status(changeId),
        });
      }
      if (!actor.scopes.includes("change:review")) {
        fail(
          "forbidden",
          "missing scope change:review",
          "Ask a repo admin to grant you change:review.",
        );
      }
      const coordinator = bindings.changeCoordinator(changeId);
      const key =
        review.idempotencyKey === undefined ? null : `review:${actor.id}:${review.idempotencyKey}`;
      if (
        key !== null &&
        !(await coordinator.claimKey({ changeId, key, ttlMs: idempotencyTtlMs }))
      ) {
        return requireChange(changeId); // a retry of a review we already accepted
      }
      try {
        // GitHub mode: GitHub merges, so a review here is recorded (the same record a GitHub
        // approval makes) and shown on the PR; there is no workflow waiting and no queue.
        if (change.host != null) {
          if (await options.isHostAuthor?.(change, actor.id)) {
            fail("self-approval", "no principal reviews its own change", {
              explanation: "You opened this pull request on GitHub. Ask another human with change:review to review it.",
              call: status(changeId),
            });
          }
          const out = await recordHostReview(ports, {
            changeId,
            headSha: review.headSha ?? change.headSha ?? "",
            reviewer: { principalId: actor.id, kind: "human" },
            decision: review.decision,
            humanLane: review.humanLane ?? null,
            comment: review.comment ?? null,
            source: "platform",
            ...(key === null ? {} : { id: await derivedId("review", changeId, key) }),
          });
          if (!out.recorded) {
            fail("invalid-state", `this review was not recorded: ${out.reason}`, {
              explanation: "Review the current head of a graded pull request.",
              call: status(changeId),
            });
          }
          const updated = await requireChange(changeId);
          await options.onHostReview?.(updated, out.review).catch(() => undefined);
          return updated;
        }
        if (change.status !== "awaiting-review" || change.headSha === null) {
          fail("invalid-state", `change is ${change.status}, not awaiting review`, {
            explanation:
              "Only changes in awaiting-review can be reviewed; check where this one is.",
            call: status(changeId),
          });
        }
        const headSha = review.headSha ?? change.headSha;
        if (headSha !== change.headSha) {
          // Reviews bind to a head: approving an older head does nothing.
          fail(
            "conflict",
            `review is for ${headSha.slice(0, 12)} but the change's head is ${change.headSha.slice(0, 12)}`,
            {
              explanation: "The author pushed again. Review the tour for the current head.",
              call: status(changeId),
            },
          );
        }
        const classification = await store.getClassification(changeId, headSha);
        if (classification === null) {
          fail("invalid-state", "the change has not been classified for this head yet", {
            explanation: "Wait until the lane is assigned, then review.",
            call: `wait_for_change({ changeId: "${changeId}", until: "lane_assigned" })`,
          });
        }
        const author = await store.getPrincipal(change.authorId);
        const viaOwner = author?.kind === "agent" && author.ownerId === actor.id;
        const decision: ReviewDecision = {
          id: key === null ? makeId() : await derivedId("review", changeId, key),
          changeId,
          headSha,
          reviewerId: actor.id,
          decision: review.decision,
          humanLane: review.humanLane ?? null,
          computedLane: classification.computedLane,
          comment: review.comment ?? null,
          createdAt: now(),
        };
        await store.putReview(decision);
        await audit.append({
          principalId: actor.id,
          action: "change.reviewed",
          subject: changeSubject(changeId),
          payload: {
            reviewId: decision.id,
            headSha,
            decision: decision.decision,
            humanLane: decision.humanLane,
            computedLane: decision.computedLane,
            lane: classification.lane,
            shadow: classification.shadow,
            // `.platform/**` (or unknown) changes: the approver above is a human other than the author.
            requiresHumanApproval: classification.requiresHumanApproval,
            approvedByAgentOwner: viaOwner,
          },
        });
        // The agent-native merge queue may hold this Change for a fresh approval (its lane rose in
        // the queue: a conflict resolution or a quarantined test). The ChangeWorkflow is past
        // review then (it waits for the merge), so the queue gets the decision directly.
        const queue = bindings.mergeQueue(change.repoId);
        if (queue.approved !== undefined) {
          // Call as a member: on a Durable Object stub every method is remote (no `.bind`).
          const q = queue as Required<Pick<MergeQueueClient, "approved">> & MergeQueueClient;
          if (decision.decision === "approve") {
            await upstream("tell the merge queue", () =>
              q.approved({
                changeId,
                lane: Math.max(change.lane ?? 0, classification.lane) as Lane,
                approver: { principalId: actor.id, kind: "human" },
              }),
            );
          } else if (await q.remove({ repoId: change.repoId, changeId }).catch(() => false)) {
            await store.updateChange(changeId, {
              status: decision.decision === "reject" ? "rejected" : "awaiting-push",
            });
          }
        }
        const event: ReviewEvent = {
          reviewId: decision.id,
          headSha,
          reviewerId: actor.id,
          decision: decision.decision,
        };
        const instance = await upstream("find the change's workflow", () =>
          bindings.changeWorkflow.get(changeWorkflowId(changeId, headSha)),
        );
        await upstream("deliver the review", () =>
          instance.sendEvent({ type: EVENT_REVIEW, payload: event }),
        );
      } catch (e) {
        if (key !== null) await coordinator.releaseKey({ changeId, key }).catch(() => undefined);
        throw e;
      }
      return requireChange(changeId);
    },

    async kill(actor, changeId, reason) {
      if (actor.kind !== "human" || !actor.scopes.includes("change:review")) {
        fail(
          "forbidden",
          "the kill switch is for humans with change:review",
          "Ask a human reviewer to use the kill switch.",
        );
      }
      const trimmed = reason.trim();
      if (trimmed === "")
        fail("invalid-input", "a reason is required", "Say why the change is being killed.");
      const change = await requireChange(changeId);
      await assertAccess(actor, change.repoId, "approve", noChange(changeId));
      if (isBootstrapChange(change)) {
        fail("invalid-state", "a bootstrap change has nothing to roll back", {
          explanation: "It only ran the first CI and preview of the initial commit.",
          call: status(changeId),
        });
      }
      if (!KILLABLE_STATUSES.includes(change.status)) {
        fail("invalid-state", `change is ${change.status}; only merged changes can be killed`, {
          explanation: "Abandon an unmerged change instead.",
          call: status(changeId),
        });
      }
      if (change.revertedBy !== null) {
        fail("conflict", `change was already reverted by ${change.revertedBy}`, {
          explanation: "Follow the revert change.",
          call: status(change.revertedBy),
        });
      }
      const repo = await requireRepo(change.repoId);
      // Stop the rollout first so it cannot advance a stage while we roll back.
      const stopped = await terminateQuietly(bindings.rolloutWorkflow, rolloutWorkflowId(changeId));
      const state = change.rolloutState;
      const flagKey = change.flagKey ?? state?.flagKey ?? null;
      if (flagKey !== null)
        await upstream("disable the change's flag", async () =>
          ports.flags.setEnabled(await ensureProjectFlagApp(ports, repo), flagKey, false),
        );
      const script = repo.deployTarget;
      const previous = state?.previousVersionId ?? null;
      const ours = state?.versionId ?? null;
      let rolledBack = false;
      let rollbackSkipped: string | null = null;
      if (script !== null && previous !== null && ours !== null) {
        // Only roll back while this change's version still serves traffic: after later
        // releases, "previous" would also drop their code. The revert change handles that case.
        const live = await upstream("read the deployment", () =>
          ports.deployer.currentVersions(script),
        );
        if (live.some((v) => v.versionId === ours && v.percentage > 0)) {
          await upstream("roll back the deployment", () =>
            ports.deployer.rollback(
              script,
              previous,
              `kill switch: ${changeId}: ${trimmed}`.slice(0, 1000),
            ),
          );
          rolledBack = true;
        } else {
          rollbackSkipped = `version ${ours} is no longer live`;
        }
      }
      if (state !== null) {
        await store.updateChange(changeId, {
          rolloutState: { ...state, status: rolledBack ? "rolled-back" : state.status },
        });
      }
      await audit.append({
        principalId: actor.id,
        action: "change.killed",
        subject: changeSubject(changeId),
        payload: {
          reason: trimmed,
          flagKey,
          rolledBack,
          rollbackSkipped,
          previousVersionId: previous,
          rolloutStopped: stopped,
        },
      });
      const fresh = await requireChange(changeId);
      const revert = await upstream("open the revert change", () =>
        openRevertChange(
          { ports, bindings },
          { original: fresh, reason: `kill switch: ${trimmed}`, actorId: actor.id },
        ),
      );
      const updated = await store.updateChange(changeId, {
        status: "reverted",
        revertedBy: revert.change.id,
      });
      await ports.notifier.notify({
        kind: "reverted",
        changeId,
        repoId: repo.id,
        message: `${actor.name} killed ${change.title}: ${trimmed}. Revert change ${revert.change.id} opened.`,
      });
      return updated;
    },

    async setLane0(actor, repoId, enabled) {
      if (actor.kind !== "human" || !actor.scopes.includes("policy:admin")) {
        fail(
          "forbidden",
          "turning Lane 0 on or off needs a human with policy:admin",
          "Ask a policy admin.",
        );
      }
      const repo = await requireRepo(repoId);
      await assertAccess(actor, repo.id, "admin", noRepo(repoId));
      if (enabled && repo.claim.status !== "claimed") {
        fail(
          "forbidden",
          "Lane 0 is off for unclaimed projects",
          "Claim the project (log in and open its claim link) first.",
        );
      }
      const samples = await store.listShadowSamples(repoId);
      const agreement = shadowAgreement(samples, repo.policy);
      if (enabled && !agreement.eligibleToEnableLane0) {
        const needed =
          agreement.needed === null
            ? "agreement can no longer reach the threshold"
            : `${agreement.needed} more agreeing reviews needed`;
        fail(
          "threshold-not-met",
          `shadow agreement ${(agreement.ratio * 100).toFixed(1)}% over ${agreement.samples} Lane-0 candidates (threshold ${(repo.policy.shadow.agreementThreshold * 100).toFixed(1)}%, min ${repo.policy.shadow.minSamples}); ${needed}`,
          "Keep reviewing Lane-0 candidates in shadow mode until humans agree often enough.",
        );
      }
      const updated = await store.updateRepo(repoId, {
        policy: { ...repo.policy, lane0Enabled: enabled },
      });
      await audit.append({
        principalId: actor.id,
        action: enabled ? "repo.lane0-enabled" : "repo.lane0-disabled",
        subject: repoSubject(repoId),
        payload: { agreement },
      });
      return updated;
    },

    async ensureProjectFlags(actor, repoId) {
      const repo = await requireRepo(repoId);
      await assertAccess(actor, repo.id, "admin", noRepo(repoId));
      if (repo.claim.status !== "claimed" || repo.deployTarget === null) {
        fail(
          "invalid-state",
          "only a claimed project with a deploy target gets a Flagship app",
          "Set the project's deploy target first.",
        );
      }
      if (repo.flagshipAppId) return repo;
      const appId = await upstream("create the project's Flagship app", () =>
        ensureProjectFlagApp(ports, repo),
      );
      await audit.append({
        principalId: actor.id,
        action: "repo.flag-app-created",
        subject: repoSubject(repoId),
        payload: { flagshipAppId: appId },
      });
      return (await store.getRepo(repoId)) ?? { ...repo, flagshipAppId: appId };
    },

    async onIssue(payload) {
      const normalized = normalizeIssue(payload, clock.now());
      if (normalized === null) return;
      const { resolved } = normalized;
      let { issue, scriptName, raw } = normalized;
      // The Issues webhook names the Worker but not the version: its newest occurrence does.
      if (issue.versionId === null && !resolved && ports.telemetry.issueOccurrence) {
        const occurrence = await ports.telemetry.issueOccurrence(issue.id).catch(() => null);
        if (occurrence?.versionId) {
          issue = { ...issue, versionId: occurrence.versionId };
          scriptName = scriptName || (occurrence.scriptName ?? "");
          raw = { notification: raw, occurrence };
        }
      }
      let change: Change | null = null;
      if (issue.versionId !== null) change = await store.getChangeByRolloutVersion(issue.versionId);
      if (change === null && issue.changeId !== null)
        change = await store.getChange(issue.changeId);
      const linked = { ...issue, changeId: change?.id ?? issue.changeId };
      await store.putIssue({ ...linked, scriptName, raw });
      if (resolved || change === null) return;
      // Within the rollout policy's tolerance (`maxNewIssueGroups` issue groups on the version),
      // an issue is stored, not acted on: health checks count it, as for the RolloutWorkflow.
      const tolerated = (await store.getRepo(change.repoId))?.policy.rollout.maxNewIssueGroups ?? 0;
      if (issue.versionId !== null) {
        const groups = new Set(
          (await store.listIssues({ versionId: issue.versionId })).map((i) => i.id),
        );
        if (groups.size <= tolerated) return;
      }
      // A version a merge-queue deploy train shipped: the train attributes it (several Changes).
      const queue = bindings.mergeQueue(change.repoId);
      if (issue.versionId !== null && queue.onIssue !== undefined) {
        const q = queue as Required<Pick<MergeQueueClient, "onIssue">>;
        const took = await q
          .onIssue({
            worker: scriptName,
            versionId: issue.versionId,
            issueId: issue.id,
            frames: framesOf(raw),
          })
          .catch(() => false);
        if (took) return;
      }
      if (change.status !== "rolling-out") return;
      try {
        const instance = await bindings.rolloutWorkflow.get(rolloutWorkflowId(change.id));
        await instance.sendEvent({ type: EVENT_ISSUE, payload: linked });
      } catch (e) {
        // The rollout finished or was stopped; the issue is stored for the record either way.
        await audit.append({
          principalId: SYSTEM_PRINCIPAL_ID,
          action: "rollout.issue-undelivered",
          subject: changeSubject(change.id),
          payload: { issueId: issue.id, error: errorMessage(e) },
        });
      }
    },

    async abandon(actor, changeId) {
      const change = await requireChange(changeId);
      if (change.status === "abandoned") return change;
      const author = await store.getPrincipal(change.authorId);
      const own = actor.id === change.authorId || author?.ownerId === actor.id;
      await assertAccess(actor, change.repoId, own ? "contribute" : "review", noChange(changeId));
      if (!canActOnChange(actor, change, author)) {
        fail("forbidden", "only the author, its owner or a reviewer can abandon a change", {
          explanation: "Ask the change's author.",
          call: status(changeId),
        });
      }
      if (FINAL_STATUSES.includes(change.status)) {
        fail("invalid-state", `change is ${change.status}`, {
          explanation:
            change.status === "merged" ||
            change.status === "rolling-out" ||
            change.status === "released"
              ? "A merged change cannot be abandoned; a human can kill it to revert it."
              : "The change has already ended.",
          call: status(changeId),
        });
      }
      await upstream("stop the change's workflow", () =>
        bindings.changeCoordinator(changeId).abandon(changeId),
      );
      await upstream("leave the merge queue", () =>
        bindings.mergeQueue(change.repoId).remove({ repoId: change.repoId, changeId }),
      );
      const updated = await store.updateChange(changeId, { status: "abandoned" });
      // A bootstrap Change has no fork (it checks out the main repo).
      if (isForkName(change.forkName)) {
        await bindings
          .changeCoordinator(changeId)
          .scheduleForkGc({ changeId, forkName: change.forkName, delayMs: forkGcDelayMs });
      }
      await audit.append({
        principalId: actor.id,
        action: "change.abandoned",
        subject: changeSubject(changeId),
        payload: { previousStatus: change.status, headSha: change.headSha },
      });
      return updated;
    },

    async waitFor(actor, changeId, until, timeoutMs) {
      const milestone = parse(WaitUntil, until, "wait");
      const watched = await requireChange(changeId);
      await assertAccess(actor, watched.repoId, "read", noChange(changeId));
      const r = await bindings
        .changeCoordinator(changeId)
        .waitFor({ changeId, until: milestone, timeoutMs: clampWait(timeoutMs) });
      const change = r.change ?? (await requireChange(changeId));
      return { change, reached: r.reached, reason: r.reason };
    },

    async watchChange(actor, changeId, opts) {
      const watched = await requireChange(changeId);
      await assertAccess(actor, watched.repoId, "read", noChange(changeId));
      const r = await bindings
        .changeCoordinator(changeId)
        .watch({ changeId, since: opts.since, timeoutMs: clampWait(opts.timeoutMs) });
      const change = r.change ?? (await requireChange(changeId));
      return { change, changed: r.changed, version: changeVersion(change) };
    },
  };
  return api;
}

/**
 * SSE helper: yields the change every time it changes until `signal` aborts. Built on
 * `watchChange`, so it works across isolates (the DO holds each long-poll).
 */
export async function* subscribeToChange(
  api: Pick<CoordinatorApi, "watchChange">,
  actor: Principal,
  changeId: string,
  opts: { signal?: AbortSignal; pollMs?: number } = {},
): AsyncGenerator<Change> {
  let since: string | null = null;
  while (opts.signal?.aborted !== true) {
    const { change, changed, version } = await api.watchChange(actor, changeId, {
      since,
      timeoutMs: opts.pollMs ?? 60_000,
    });
    if (changed || since === null) yield change;
    since = version;
  }
}
