/**
 * The four onboarding tasks (docs/prompts/02-onboarding.md §7), VERBATIM.
 *
 * Never tune these texts to make a run pass: when an agent stumbles, fix the platform (an error
 * message, a missing `fix` hint, a tool description, a template, /start) and log the fix in
 * DECISIONS.md with the run id. See evals/onboarding/README.md.
 */

export const TASK_IDS = ["t1", "t2", "t3", "t4"] as const;
export type TaskId = (typeof TASK_IDS)[number];

/** The agent-side tools the harness offers. */
export const TOOL_NAMES = [
  "http_fetch",
  "mcp_connect",
  "mcp_list_tools",
  "mcp_call",
  "shell",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const REMOTE_TOOLS: readonly ToolName[] = [
  "http_fetch",
  "mcp_connect",
  "mcp_list_tools",
  "mcp_call",
];
const LOCAL_TOOLS: readonly ToolName[] = [...REMOTE_TOOLS, "shell"];

export interface TaskDef {
  id: TaskId;
  /** Short label for reports. */
  title: string;
  /** Tools offered to the agent. Task 4 has no `shell` (remote-only: open_workspace only). */
  tools: readonly ToolName[];
  /** Whether the task ends in a live preview (preview probes and time-to-first-green). */
  previews: boolean;
}

export const TASKS: Record<TaskId, TaskDef> = {
  t1: { id: "t1", title: "Workers API → preview", tools: LOCAL_TOOLS, previews: true },
  t2: { id: "t2", title: "Import + fix failing test", tools: LOCAL_TOOLS, previews: true },
  t3: { id: "t3", title: "TS library public API field", tools: LOCAL_TOOLS, previews: false },
  t4: { id: "t4", title: "Task 1, remote-only", tools: REMOTE_TOOLS, previews: true },
};

export const TASK_1_TEXT =
  "Create a Workers API that returns the current time and get it deployed to a preview.";
export const TASK_3_TEXT = "Add a field to the TS library's public API.";

export function task2Text(importRepoUrl: string): string {
  return `Import ${importRepoUrl} and fix the failing test.`;
}

export type TaskPrompt = { ok: true; text: string } | { ok: false; skipReason: string };

/** The task text the agent receives, or why the task can't run in this deployment. */
export function taskPrompt(task: TaskId, cfg: { importRepoUrl?: string | undefined }): TaskPrompt {
  switch (task) {
    case "t1":
    case "t4":
      return { ok: true, text: TASK_1_TEXT };
    case "t3":
      return { ok: true, text: TASK_3_TEXT };
    case "t2": {
      const url = cfg.importRepoUrl?.trim();
      if (!url) return { ok: false, skipReason: "fixture repo not published" };
      return { ok: true, text: task2Text(url) };
    }
  }
}

/**
 * The whole system prompt: who the agent is and the one URL it gets. Nothing else (no hints, no
 * credentials, no MCP URL: the agent discovers everything from /start).
 */
export function systemPrompt(host: string): string {
  const h = host.replace(/\/+$/, "");
  return `You are a coding agent. Platform: ${h}. Start at ${h}/start.`;
}

export function isTaskId(v: unknown): v is TaskId {
  return typeof v === "string" && (TASK_IDS as readonly string[]).includes(v);
}
