/**
 * The slice of JSON Schema the CLI reads from MCP tool definitions (or a live `tools/list`) to
 * derive commands and flags. Anything it doesn't understand becomes a JSON-valued flag.
 */

export interface JsonSchema {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly description?: string;
  readonly items?: JsonSchema;
  readonly properties?: { readonly [name: string]: JsonSchema };
  readonly required?: readonly string[];
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly default?: unknown;
  readonly [keyword: string]: unknown;
}

export interface ToolHints {
  readonly readOnlyHint?: boolean | undefined;
  readonly destructiveHint?: boolean | undefined;
  readonly idempotentHint?: boolean | undefined;
  readonly openWorldHint?: boolean | undefined;
}

/** One MCP tool as `tools/list` describes it (and as `defineTools` declares it). */
export interface WireTool {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema: JsonSchema;
  readonly annotations?: ToolHints | undefined;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSchema(v: unknown): v is JsonSchema {
  return isRecord(v);
}

/** Validates one `tools/list` entry from a server (external input). */
export function toWireTool(v: unknown): WireTool | null {
  if (!isRecord(v) || typeof v.name !== "string" || v.name.length === 0) return null;
  const inputSchema = isSchema(v.inputSchema) ? v.inputSchema : { type: "object" };
  const ann = isRecord(v.annotations) ? v.annotations : undefined;
  const bool = (x: unknown) => (typeof x === "boolean" ? x : undefined);
  return {
    name: v.name,
    title: typeof v.title === "string" ? v.title : undefined,
    description: typeof v.description === "string" ? v.description : undefined,
    inputSchema,
    annotations: ann
      ? {
          readOnlyHint: bool(ann.readOnlyHint),
          destructiveHint: bool(ann.destructiveHint),
          idempotentHint: bool(ann.idempotentHint),
          openWorldHint: bool(ann.openWorldHint),
        }
      : undefined,
  };
}

/** The non-null JSON types a schema allows (`["string", "null"]` → `["string"]`). */
export function schemaTypes(s: JsonSchema): string[] {
  const t = s.type;
  const list = typeof t === "string" ? [t] : Array.isArray(t) ? t.filter((x) => typeof x === "string") : [];
  return list.filter((x) => x !== "null");
}
