/**
 * One tool call's result: what the model sees, plus the side state the harness keeps (harvested
 * platform ids, the MCP connection, preview probes). Serializable: it is a Workflow step result.
 */

export interface Harvest {
  repoIds: string[];
  changeIds: string[];
  planIds: string[];
  previewUrls: string[];
}

export interface McpState {
  url: string;
  token: string | null;
  sessionId: string | null;
  protocolVersion: string | null;
}

export interface ToolOutcome {
  /** What the model sees (already truncated). */
  content: string;
  isError: boolean;
  /** Platform `error.code`s found in the result. */
  errorCodes: string[];
  /** Epoch ms when the call finished. */
  at: number;
  durationMs: number;
  meta: {
    harvest?: Harvest;
    /** Set by mcp_connect: the new connection (null = disconnected after a failed connect). */
    mcp?: McpState | null;
    /** A preview URL first seen serving a current ISO timestamp, and when. */
    firstGreen?: { url: string; at: number };
    /** mcp_call only: the MCP tool that was called. */
    mcpTool?: string;
  };
}

export function errorOutcome(content: string, at: number, durationMs = 0): ToolOutcome {
  return { content, isError: true, errorCodes: [], at, durationMs, meta: {} };
}

export function emptyHarvest(): Harvest {
  return { repoIds: [], changeIds: [], planIds: [], previewUrls: [] };
}

export function mergeHarvest(into: Harvest, add: Harvest | undefined): Harvest {
  if (!add) return into;
  const u = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return {
    repoIds: u(into.repoIds, add.repoIds),
    changeIds: u(into.changeIds, add.changeIds),
    planIds: u(into.planIds, add.planIds),
    previewUrls: u(into.previewUrls, add.previewUrls),
  };
}
