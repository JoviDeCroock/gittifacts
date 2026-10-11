/**
 * The merged pull requests of a window (research §8): GraphQL `pullRequests(states: MERGED)`,
 * newest update first, 50 a page with their files, labels, merge commit and closing issues
 * (~3 points a page on a busy repo). GitHub can't order by merge date, so pages run until the
 * last update is older than the window, and `mergedAt` filters. Only PRs into the default branch.
 */
import { z } from "zod";
import type { GithubApi } from "../api.js";

export const MERGED_PRS = `query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: MERGED, first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body createdAt mergedAt updatedAt headRefName baseRefName
        author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
        mergeCommit { oid }
        files(first: 100) { nodes { path additions deletions } }
        labels(first: 20) { nodes { name } }
        closingIssuesReferences(first: 5) { nodes { number } }
      }
    }
  }
  rateLimit { cost remaining }
}`;

const Node = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().default(null),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
  updatedAt: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  author: z
    .object({
      __typename: z.string(),
      login: z.string(),
      databaseId: z.number().int().nullable().optional(),
    })
    .nullable(),
  mergeCommit: z.object({ oid: z.string().regex(/^[0-9a-f]{40}$/) }).nullable(),
  files: z
    .object({
      nodes: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number() })),
    })
    .nullable(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullable(),
  closingIssuesReferences: z
    .object({ nodes: z.array(z.object({ number: z.number() })) })
    .nullable(),
});

const Page = z.object({
  repository: z.object({
    pullRequests: z.object({
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(Node),
    }),
  }),
  rateLimit: z.object({ cost: z.number(), remaining: z.number() }).nullable().optional(),
});

export interface MergedPr {
  number: number;
  title: string;
  body: string | null;
  createdAt: string;
  mergedAt: string;
  headRefName: string;
  author: { login: string; id: number | null; type: string } | null;
  mergeSha: string;
  files: { path: string; additions: number; deletions: number }[];
  labels: string[];
  closingIssues: number[];
}

export interface Listing {
  prs: MergedPr[];
  pages: number;
  points: number;
  /** True when the page cap stopped the walk before the window's start. */
  truncated: boolean;
}

export async function listMergedPrs(
  api: Pick<GithubApi, "graphql">,
  input: {
    owner: string;
    repo: string;
    defaultBranch: string;
    since: Date;
    until: Date;
    maxPages?: number;
  },
): Promise<Listing> {
  const prs: MergedPr[] = [];
  let after: string | null = null;
  let pages = 0;
  let points = 0;
  const maxPages = input.maxPages ?? 40;
  for (;;) {
    const raw = await api.graphql(MERGED_PRS, { owner: input.owner, repo: input.repo, after });
    const page = Page.parse(raw);
    pages++;
    points += page.rateLimit?.cost ?? 1;
    const conn = page.repository.pullRequests;
    let older = false;
    for (const n of conn.nodes) {
      if (Date.parse(n.updatedAt) < input.since.getTime()) older = true;
      if (n.mergedAt === null || n.mergeCommit === null || n.baseRefName !== input.defaultBranch)
        continue;
      const merged = Date.parse(n.mergedAt);
      if (merged < input.since.getTime() || merged > input.until.getTime()) continue;
      prs.push({
        number: n.number,
        title: n.title,
        body: n.body,
        createdAt: n.createdAt,
        mergedAt: n.mergedAt,
        headRefName: n.headRefName,
        author:
          n.author === null
            ? null
            : { login: n.author.login, id: n.author.databaseId ?? null, type: n.author.__typename },
        mergeSha: n.mergeCommit.oid,
        files: n.files?.nodes ?? [],
        labels: (n.labels?.nodes ?? []).map((l) => l.name),
        closingIssues: (n.closingIssuesReferences?.nodes ?? []).map((i) => i.number),
      });
    }
    if (older || !conn.pageInfo.hasNextPage || conn.pageInfo.endCursor === null) {
      return {
        prs: prs.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt)),
        pages,
        points,
        truncated: false,
      };
    }
    if (pages >= maxPages)
      return {
        prs: prs.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt)),
        pages,
        points,
        truncated: true,
      };
    after = conn.pageInfo.endCursor;
  }
}
