/**
 * GitHub glue for QA: the view the summary comment and check run render (with signed thumbnail
 * URLs), and the port the Run QA button and `/gittifacts qa` call. Thumbnail URLs are signed from
 * the run's finish time, so the same run always renders the same text (the summary comment is
 * edited only when its text changes).
 */
import { type GithubQaPort, type QaView, qaSummary, type SummaryQa } from "@app/host-github";
import { drizzle } from "drizzle-orm/d1";
import type { Bindings } from "../app-env.js";
import { ApiError } from "../errors.js";
import { platformOrigin } from "../integrations/runtime.js";
import { D1Store } from "../store/d1-store.js";
import { signedQaImageUrl } from "./images.js";
import { type QaEnv, requestQa } from "./request.js";
import { QaStore, viewOf } from "./store.js";

/** The summary comment's (and check run's) QA section for the head's latest run. */
export function qaSectionFor(
  env: Bindings,
): (changeId: string, headSha: string) => Promise<SummaryQa | null> {
  const view = qaViewFor(env);
  return async (changeId, headSha) => {
    const v = await view(changeId, headSha);
    return v === null ? null : qaSummary(v);
  };
}

export function qaViewFor(
  env: Bindings,
): (changeId: string, headSha: string) => Promise<QaView | null> {
  return async (changeId, headSha) => {
    const row = await new QaStore(drizzle(env.DB)).forHead(changeId, headSha);
    if (row === null) return null;
    const run = viewOf(row);
    const origin = platformOrigin(env);
    const report = run.report;
    const signedAt = Date.parse(run.finishedAt ?? run.createdAt);
    const thumbs = [];
    for (const a of (report?.artifacts ?? []).filter((x) => x.role === "thumb").slice(0, 4)) {
      const index = Number(/^c(\d+)-/.exec(a.name)?.[1] ?? -1);
      const alt = report?.criteria.find((c) => c.index === index)?.text ?? "QA screenshot";
      thumbs.push({
        url: await signedQaImageUrl(env.BETTER_AUTH_SECRET, origin, run.id, a.name, signedAt),
        alt,
      });
    }
    let requestedBy: string | null = run.requestedLogin === null ? null : `@${run.requestedLogin}`;
    if (requestedBy === null)
      requestedBy =
        (await new D1Store(env.DB, env.BLOBS).getPrincipal(run.requestedBy))?.name ?? null;
    return {
      runId: run.id,
      headSha: run.headSha,
      status: run.status,
      passed: run.summary?.passed ?? 0,
      failed: run.summary?.failed ?? 0,
      couldntTest: run.summary?.couldntTest ?? 0,
      criteria: (report?.criteria ?? []).map((c) => ({
        text: c.text,
        verdict: c.verdict,
        reason: c.reason,
      })),
      thumbs,
      reportUrl: `${origin}/changes/${encodeURIComponent(changeId)}#qa`,
      error: run.error,
      requestedBy,
    };
  };
}

export function githubQaPort(env: Bindings): GithubQaPort {
  return {
    request: async ({ changeId, principalId, login, via }) => {
      if (env.QA_WORKFLOW === undefined) return { refused: "QA is not available on this platform" };
      try {
        const out = await requestQa(env as unknown as QaEnv, {
          changeId,
          principalId,
          trigger: via,
          login,
        });
        return { runId: out.run.id, reused: out.reused };
      } catch (e) {
        if (e instanceof ApiError) return { refused: e.message };
        throw e;
      }
    },
  };
}
