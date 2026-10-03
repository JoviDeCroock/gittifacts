/**
 * The parts of GitHub webhook payloads we read, validated with zod (deliveries are untrusted even
 * after the HMAC check: they say what GitHub saw, not what is true now). Lenient: unknown fields
 * pass through, and anything we don't read is not required.
 */
import { z } from "zod";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

export const GithubAccount = z
  .object({ login: z.string().min(1), id: z.number().int(), type: z.string().default("User") })
  .passthrough();
export type GithubAccount = z.infer<typeof GithubAccount>;

export const GithubRepo = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    full_name: z.string().min(3),
    private: z.boolean().default(false),
    default_branch: z.string().min(1).default("main"),
    owner: GithubAccount,
  })
  .passthrough();
export type GithubRepo = z.infer<typeof GithubRepo>;

const Branch = z
  .object({
    ref: z.string().min(1),
    sha: Sha,
    // `null` when the fork was deleted.
    repo: GithubRepo.pick({ id: true, full_name: true }).passthrough().nullable(),
  })
  .passthrough();

export const PullRequest = z
  .object({
    number: z.number().int().positive(),
    title: z.string().default(""),
    body: z.string().nullable().default(null),
    state: z.enum(["open", "closed"]),
    draft: z.boolean().default(false),
    merged: z.boolean().nullable().default(false),
    merge_commit_sha: Sha.nullable().default(null),
    html_url: z.string().url(),
    user: GithubAccount,
    head: Branch,
    base: Branch,
    labels: z.array(z.object({ name: z.string() }).passthrough()).default([]),
    maintainer_can_modify: z.boolean().default(false),
  })
  .passthrough();
export type PullRequest = z.infer<typeof PullRequest>;

const Installation = z.object({ id: z.number().int().positive() }).passthrough();

export const PullRequestEvent = z
  .object({
    action: z.string(),
    number: z.number().int().positive(),
    pull_request: PullRequest,
    repository: GithubRepo,
    installation: Installation.optional(),
    before: Sha.optional(),
    after: Sha.optional(),
    sender: GithubAccount.optional(),
  })
  .passthrough();
export type PullRequestEvent = z.infer<typeof PullRequestEvent>;

export const PullRequestReviewEvent = z
  .object({
    action: z.string(),
    review: z
      .object({
        id: z.number().int(),
        state: z.string(),
        commit_id: Sha,
        user: GithubAccount,
      })
      .passthrough(),
    pull_request: PullRequest,
    repository: GithubRepo,
    installation: Installation.optional(),
  })
  .passthrough();

export const PushEvent = z
  .object({
    ref: z.string(),
    before: Sha,
    after: Sha,
    forced: z.boolean().default(false),
    repository: GithubRepo,
    installation: Installation.optional(),
  })
  .passthrough();

export const MergeGroupEvent = z
  .object({
    action: z.string(),
    merge_group: z
      .object({ head_sha: Sha, head_ref: z.string(), base_sha: Sha, base_ref: z.string() })
      .passthrough(),
    repository: GithubRepo,
    installation: Installation.optional(),
  })
  .passthrough();

export const IssueEvent = z
  .object({
    action: z.string(),
    issue: z.object({ number: z.number().int().positive() }).passthrough(),
    label: z.object({ name: z.string() }).passthrough().optional(),
    repository: GithubRepo,
    installation: Installation.optional(),
  })
  .passthrough();

/** One delivery as the queue carries it: the event name and the parsed JSON body. */
export interface GithubDelivery {
  event: string;
  payload: unknown;
}
