/** A QA run as MCP and the CLI show it (`@app/mcp` QaRunBrief). */
import type { QaRunBrief } from "@app/mcp";
import type { QaRunView } from "./store.js";

export function qaBrief(r: QaRunView, origin: string): QaRunBrief {
  return {
    id: r.id,
    changeId: r.changeId,
    headSha: r.headSha,
    status: r.status,
    progress: r.progress,
    summary: r.summary,
    laneBefore: r.laneBefore,
    laneAfter: r.laneAfter,
    costUsd: r.costUsd,
    wallMs: r.wallMs,
    error: r.error,
    criteria: (r.report?.criteria ?? []).map((c) => ({
      text: c.text,
      verdict: c.verdict,
      reason: c.reason,
    })),
    artifacts: (r.report?.artifacts ?? []).map((a) => ({ name: a.name, ref: a.ref, role: a.role })),
    reportUrl: `${origin.replace(/\/+$/, "")}/changes/${encodeURIComponent(r.changeId)}#qa`,
  };
}
