/**
 * QA on request, for HTTP and MCP callers (GitHub triggers call `requestQa` directly after their
 * own write-access check). Who may ask: anyone who may contribute to the repo (its reviewers and
 * up, and their agents). Asking costs browser and model time, so it is audited.
 */
import { drizzle } from "drizzle-orm/d1";
import { assertChangeAccess } from "../access/access.js";
import type { Caller, Services } from "../app-env.js";
import { ApiError } from "../errors.js";
import { type QaEnv, type QaRequestResult, requestQa } from "../qa/request.js";
import { type QaRunView, QaStore, viewOf } from "../qa/store.js";

export async function requestQaFor(
  svc: Services,
  caller: Caller,
  changeId: string,
  opts: { force?: boolean; trigger: "platform" | "mcp" | "cli" },
): Promise<QaRequestResult> {
  await assertChangeAccess(svc, caller.principal, changeId, "contribute");
  if (svc.env.QA_WORKFLOW === undefined)
    throw new ApiError(503, "upstream", "QA runs are not available in this deployment");
  const out = await requestQa(
    svc.env as unknown as QaEnv,
    {
      changeId,
      principalId: caller.principal.id,
      trigger: opts.trigger,
      ...(opts.force === true ? { force: true } : {}),
    },
    () => svc.clock.now(),
  );
  if (!out.reused) {
    await svc.audit.append({
      principalId: caller.principal.id,
      action: "change.qa-requested",
      subject: `change:${changeId}`,
      payload: {
        runId: out.run.id,
        headSha: out.run.headSha,
        via: opts.trigger,
        force: opts.force === true,
      },
    });
  }
  return out;
}

export async function listQaRuns(
  svc: Services,
  caller: Caller,
  changeId: string,
): Promise<QaRunView[]> {
  await assertChangeAccess(svc, caller.principal, changeId, "read");
  return (await new QaStore(drizzle(svc.env.DB)).forChange(changeId)).map(viewOf);
}
