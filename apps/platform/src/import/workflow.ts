/**
 * `PlatformConfigWorkflow`: one instance per proposal (`pcfg-<repoId>-<sha12>-<n>`), durable and
 * retried step by step:
 *
 *   base → detect (sandbox) → plan (draft, authored by `system`) → change (fork, category chore)
 *   → commit (a system workspace writes the files and pushes them to the fork) → done
 *
 * The push goes to the Change's fork and starts the normal flow: CI → evidence → lane (2, since
 * it touches .platform/**, with requiresHumanApproval) → tour → a human. Nothing is applied to the
 * default branch by this workflow; the system principal never approves anything.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { resolveRuntime, SYSTEM_PRINCIPAL_ID } from "@app/coordinator";
import { z } from "zod";
import type { Bindings } from "../app-env.js";
import { type DetectSummary, runProposalSteps } from "./steps.js";

export const ProposalParams = z.object({
  proposalId: z.string().min(1).max(100),
  repoId: z.string().min(1).max(64),
  requestedBy: z.string().min(1).max(64),
  host: z.string().url(),
});
export type ProposalParams = z.infer<typeof ProposalParams>;

export interface ProposalOutput {
  baseSha: string;
  planId: string | null;
  changeId: string | null;
  headSha: string | null;
  detection: DetectSummary;
  /** Nothing to propose: the repo already has every file. */
  notNeeded: boolean;
}

const RETRY = {
  retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const;

export class PlatformConfigWorkflow extends WorkflowEntrypoint<Bindings, unknown> {
  override async run(
    event: Readonly<WorkflowEvent<unknown>>,
    step: WorkflowStep,
  ): Promise<ProposalOutput> {
    const params = ProposalParams.parse(event.payload);
    // Fail fast when the runtime isn't configured (the Worker entry does it at top level).
    resolveRuntime(this.env, "default");
    return runProposalSteps({
      env: this.env,
      ctx: this.ctx,
      params,
      actorId: SYSTEM_PRINCIPAL_ID,
      step: <T>(name: string, fn: () => Promise<T>) =>
        step.do(name, RETRY, async () => (await fn()) as Rpc.Serializable<T>) as Promise<T>,
    });
  }
}
