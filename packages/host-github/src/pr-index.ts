/**
 * What gittifacts wrote on each pull request, so it edits instead of re-posting: the tour review
 * per head (and its inline comment ids, to stale them), the one summary comment and the hash of
 * its text, and "full review" requests from the check run's button. The platform keeps it in D1.
 */

export interface StoredReview {
  changeId: string;
  headSha: string;
  reviewId: number;
  /** GraphQL node id (minimizing a stale review). */
  nodeId: string;
  commentIds: number[];
  staleAt: string | null;
}

export interface PrIndex {
  review(changeId: string, headSha: string): Promise<StoredReview | null>;
  reviews(changeId: string): Promise<StoredReview[]>;
  putReview(review: StoredReview): Promise<void>;
  markStale(changeId: string, headSha: string, at: string): Promise<void>;
  summary(changeId: string): Promise<{ commentId: number; hash: string } | null>;
  putSummary(changeId: string, commentId: number, hash: string): Promise<void>;
  fullReviews(changeId: string, headSha: string): Promise<{ by: string }[]>;
  addFullReview(changeId: string, headSha: string, by: string): Promise<void>;
}

export function memoryPrIndex(): PrIndex {
  const reviews = new Map<string, StoredReview>();
  const summaries = new Map<string, { commentId: number; hash: string }>();
  const full = new Map<string, Set<string>>();
  const key = (c: string, h: string) => `${c}@${h}`;
  return {
    review: async (c, h) => reviews.get(key(c, h)) ?? null,
    reviews: async (c) => [...reviews.values()].filter((r) => r.changeId === c),
    putReview: async (r) => {
      reviews.set(key(r.changeId, r.headSha), { ...r });
    },
    markStale: async (c, h, at) => {
      const r = reviews.get(key(c, h));
      if (r !== undefined) r.staleAt = at;
    },
    summary: async (c) => summaries.get(c) ?? null,
    putSummary: async (c, commentId, hash) => {
      summaries.set(c, { commentId, hash });
    },
    fullReviews: async (c, h) => [...(full.get(key(c, h)) ?? [])].map((by) => ({ by })),
    addFullReview: async (c, h, by) => {
      const s = full.get(key(c, h)) ?? new Set<string>();
      s.add(by);
      full.set(key(c, h), s);
    },
  };
}
