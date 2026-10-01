/** Runtime-agnostic constants shared by the Workflow and the engines (no `cloudflare:*` imports). */
import { CI_PATH } from "@app/domain";

/** `.platform/ci.ts`, evaluated in plan mode inside the sandbox. */
export const CI_PIPELINE_FILE: string = CI_PATH;

/** Workflow step names the engine uses besides pipeline steps. */
export const ENGINE_STEPS = { plan: "plan", prepare: "prepare", finalize: "finalize" } as const;
