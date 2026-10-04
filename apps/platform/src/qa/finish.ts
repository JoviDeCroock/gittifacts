/**
 * After the browser: the signed `qa-run` item joins the head's evidence bundle (resealed, like
 * screenshots), the stored classification is raised by it (`raiseForQa`: keep or raise, never
 * lower), the spend is charged to the Change's AI budget, the humans are notified, and on GitHub
 * the check run and the one summary comment are updated. Idempotent per run (a retried step finds
 * the row done and only recomputes what it returns).
 */
import { raiseForQa } from "@app/classifier";
import { persistClassification, resolveRuntime, sealEvidence, withdrawApprovalsForQa } from "@app/coordinator";
import { laneLabel } from "@app/domain/vocabulary";
import type { QaRun } from "@app/evidence";
import { routeVerdict } from "@app/host";
import { drizzle } from "drizzle-orm/d1";
import type { Bindings } from "../app-env.js";
import { githubHostFor } from "../github/runtime.js";
import { D1Notifier } from "../notifier.js";
import { D1Store } from "../store/d1-store.js";
import { QaStore } from "./store.js";

export interface QaFinish {
  runId: string;
  changeId: string;
  repoId: string;
  headSha: string;
  /** The head is still the change's current one (the lane and bundle were updated). */
  current: boolean;
  laneBefore: number | null;
  laneAfter: number | null;
  status: QaRun["status"];
}

const count = (item: QaRun, v: string) => item.criteria.filter((c) => c.verdict === v).length;

export async function finishQaRun(env: Bindings, runId: string, item: QaRun): Promise<QaFinish> {
  const qa = new QaStore(drizzle(env.DB));
  const row = await qa.get(runId);
  if (row === null) throw new Error(`qa run ${runId} not found`);
  const { ports, bindings } = resolveRuntime(env, "default");
  const store = ports.store;
  const change = await store.getChange(row.changeId);
  const current = change?.headSha === row.headSha;
  const base = {
    runId,
    changeId: row.changeId,
    repoId: row.repoId,
    headSha: row.headSha,
    current,
    status: item.status,
  };
  if (row.status === "done" || row.status === "failed")
    return { ...base, laneBefore: row.laneBefore, laneAfter: row.laneAfter };

  // The bundle: only the current head's (resealing an old head would repoint the change's evidence).
  const evidence = await store.getEvidence(row.changeId, row.headSha);
  if (current && evidence !== null) {
    await sealEvidence(ports, {
      changeId: row.changeId,
      headSha: row.headSha,
      baseSha: evidence.baseSha,
      items: [...evidence.items.filter((i) => i.kind !== "qa-run"), item],
      notesWritten: evidence.notesWritten,
    });
  }
  // The lane: raised by the run, never lowered.
  const before = await store.getClassification(row.changeId, row.headSha);
  let laneAfter: number | null = before?.lane ?? null;
  if (before !== null) {
    const raised = raiseForQa(before, item);
    laneAfter = raised.lane;
    if (current)
      await persistClassification(store, {
        changeId: row.changeId,
        headSha: row.headSha,
        result: raised,
      });
    else await store.putClassification(row.changeId, row.headSha, raised);
  }
  if (item.usage.llmUsd > 0)
    await bindings
      .changeCoordinator(row.changeId)
      .recordSpend({ changeId: row.changeId, usd: item.usage.llmUsd })
      .catch(() => 0);

  // A failed criterion withdraws the head's approvals (user decision); "couldn't test" and
  // errored runs only raise the lane.
  const failedTexts = item.status === "ok" ? item.criteria.filter((c) => c.verdict === "fail").map((c) => c.text) : [];
  let withdrawn: Array<{ reviewId: string; reviewerId: string; name: string }> = [];
  if (current && failedTexts.length > 0) {
    const out = await withdrawApprovalsForQa(ports, bindings, { changeId: row.changeId, headSha: row.headSha, runId, failed: failedTexts });
    withdrawn = await Promise.all(
      out.withdrawn.map(async (r) => ({ reviewId: r.id, reviewerId: r.reviewerId, name: (await store.getPrincipal(r.reviewerId))?.name ?? r.reviewerId })),
    );
  }

  const now = new Date().toISOString();
  await qa.update(runId, {
    withdrawn: withdrawn.length > 0 ? withdrawn : null,
    status: item.status === "ok" ? "done" : "failed",
    progress: null,
    item,
    passed: count(item, "pass"),
    failed: count(item, "fail"),
    couldntTest: count(item, "couldnt-test"),
    laneBefore: before?.lane ?? null,
    laneAfter,
    costUsd: item.usage.llmUsd,
    wallMs: item.usage.wallMs,
    error: item.status === "ok" ? null : (item.note ?? "QA could not run").slice(0, 2000),
    finishedAt: now,
  });
  await ports.audit.append({
    principalId: "system",
    action: "change.qa-finished",
    subject: `change:${row.changeId}`,
    payload: {
      runId,
      headSha: row.headSha,
      status: item.status,
      passed: count(item, "pass"),
      failed: count(item, "fail"),
      couldntTest: count(item, "couldnt-test"),
      laneBefore: before?.lane ?? null,
      laneAfter,
      costUsd: item.usage.llmUsd,
    },
  });
  const raisedText =
    before !== null && laneAfter !== null && laneAfter > before.lane
      ? ` The lane went from ${laneLabel(before.lane)} to ${laneLabel(laneAfter as 0 | 1 | 2)}.`
      : "";
  const what =
    item.status !== "ok"
      ? `QA could not run on ${change?.title ?? row.changeId} at ${row.headSha.slice(0, 12)}: ${(item.note ?? "").slice(0, 200)}.`
      : `QA on ${change?.title ?? row.changeId} at ${row.headSha.slice(0, 12)}: ${count(item, "pass")} passed, ${count(item, "fail")} failed, ${count(item, "couldnt-test")} couldn't test.`;
  await new D1Notifier(new D1Store(env.DB, env.BLOBS)).notify({
    kind: "qa-finished",
    changeId: row.changeId,
    repoId: row.repoId,
    message: `${what}${raisedText}`,
  });
  return { ...base, laneBefore: before?.lane ?? null, laneAfter };
}

/** GitHub: the check run with the (raised) verdict and QA, then the summary comment's QA section. */
export async function publishQaOnGithub(env: Bindings, f: QaFinish): Promise<void> {
  if (!f.current) return;
  const { ports } = resolveRuntime(env, "github");
  const [change, repo] = await Promise.all([
    ports.store.getChange(f.changeId),
    ports.store.getRepo(f.repoId),
  ]);
  if (change?.host == null || repo?.host == null) return;
  const cls = await ports.store.getClassification(f.changeId, f.headSha);
  const evidence = await ports.store.getEvidence(f.changeId, f.headSha);
  const { host, release } = githubHostFor(env, ports, repo.host);
  const ref = {
    host: "github" as const,
    owner: repo.host.owner,
    repo: repo.host.repo,
    number: change.host.number,
  };
  try {
    if (cls !== null) {
      const route = routeVerdict({ ...cls, autoMergeAllowed: false }, host.capabilities());
      const tour = (await ports.store.getTour?.(f.changeId, f.headSha)) ?? null;
      await host.publishVerdict(ref, {
        ...cls,
        headSha: f.headSha,
        action: route.action,
        degradations: route.degradations,
        tourStatus:
          tour !== null
            ? "ok"
            : cls.reasons.some((r) => r.code === "tour.failed")
              ? "failed"
              : "not-generated",
        preliminary: false,
        evidence:
          evidence === null
            ? null
            : { id: evidence.id, verified: (await ports.signer.verifyEvidence(evidence)).ok },
      });
    }
    await host.publishSummary?.(ref);
  } finally {
    await release();
  }
}
