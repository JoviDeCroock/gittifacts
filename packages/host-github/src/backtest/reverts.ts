/**
 * Which merged PRs were later reverted (research §8), from the listing alone (no extra API
 * calls): GitHub's Revert button (`revert-<N>-<branch>` head ref, body "Reverts owner/repo#N"),
 * a `Revert "<title>"` title, or git's "This reverts commit <sha>." pointing at a merge commit.
 * A revert of a revert (a re-land) still marks the original: it was reverted when it shipped.
 */
import type { MergedPr } from "./listing.js";

export interface RevertLink {
  /** The revert PR. */
  by: number;
  how: "branch" | "body" | "title" | "sha";
  /** When the revert merged. */
  at: string;
}

export function findReverts(
  prs: readonly MergedPr[],
  repoFullName: string,
): Map<number, RevertLink> {
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const byTitle = new Map<string, MergedPr[]>();
  for (const p of prs) byTitle.set(p.title.trim(), [...(byTitle.get(p.title.trim()) ?? []), p]);
  const out = new Map<number, RevertLink>();
  const mark = (target: number | undefined, r: MergedPr, how: RevertLink["how"]) => {
    if (target === undefined || target === r.number) return;
    const t = byNumber.get(target);
    if (t === undefined || t.mergedAt > r.mergedAt) return; // a revert comes after what it reverts
    if (!out.has(target)) out.set(target, { by: r.number, how, at: r.mergedAt });
  };
  const repoRef = repoFullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const r of prs) {
    const branch = /^revert-(\d+)-/.exec(r.headRefName);
    if (branch !== null) {
      mark(Number(branch[1]), r, "branch");
      continue;
    }
    const body = new RegExp(`^\\s*Reverts\\s+(?:${repoRef})?#(\\d+)`, "im").exec(r.body ?? "");
    if (body !== null) {
      mark(Number(body[1]), r, "body");
      continue;
    }
    const sha = /This reverts commit ([0-9a-f]{7,40})/i.exec(r.body ?? "");
    if (sha !== null) {
      const target = prs.find((p) => p.mergeSha.startsWith((sha[1] ?? "").toLowerCase()));
      if (target !== undefined) {
        mark(target.number, r, "sha");
        continue;
      }
    }
    const title = /^Revert "(.+)"$/.exec(r.title.trim());
    if (title !== null) {
      const candidates = (byTitle.get((title[1] ?? "").trim()) ?? []).filter(
        (p) => p.mergedAt <= r.mergedAt,
      );
      mark(candidates.at(-1)?.number, r, "title");
    }
  }
  return out;
}
