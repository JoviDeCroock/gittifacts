/**
 * JSON Schema → short, readable type strings and flattened field rows for reference tables.
 */

export interface JsonSchema {
  type?: string | string[];
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
  additionalProperties?: boolean | JsonSchema;
  $ref?: string;
}

export function typeOf(s: JsonSchema | undefined, depth = 0): string {
  if (s === undefined) return "any";
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  const variants = s.anyOf ?? s.oneOf;
  if (variants) return variants.map((v) => typeOf(v, depth)).join(" | ");
  if (s.$ref) return s.$ref.split("/").at(-1) ?? "object";
  const types = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type];
  const parts = types.map((t) => {
    if (t === "array") {
      const item = typeOf(s.items, depth + 1);
      return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
    }
    if (t === "object" && s.properties && depth < 1) {
      const keys = Object.keys(s.properties);
      return keys.length <= 4 ? `{ ${keys.join(", ")} }` : "object";
    }
    return t;
  });
  if (parts.length === 0) return s.properties ? "object" : "any";
  return parts.join(" | ");
}

/** Constraints worth showing: ranges, lengths, patterns, defaults. */
export function constraintsOf(s: JsonSchema): string {
  const out: string[] = [];
  const max = s.maximum === Number.MAX_SAFE_INTEGER ? undefined : s.maximum;
  if (s.minimum !== undefined && max !== undefined) out.push(`${s.minimum}–${max}`);
  else if (s.minimum !== undefined) out.push(`≥ ${s.minimum}`);
  else if (max !== undefined) out.push(`≤ ${max}`);
  if (s.exclusiveMinimum !== undefined) out.push(`> ${s.exclusiveMinimum}`);
  if (s.maxLength !== undefined) out.push(`max ${s.maxLength} chars`);
  if (s.maxItems !== undefined) out.push(`max ${s.maxItems} items`);
  if (s.format !== undefined) out.push(s.format);
  if (s.default !== undefined) out.push(`default ${JSON.stringify(s.default)}`);
  return out.join(", ");
}

export interface FieldRow {
  path: string;
  type: string;
  required: boolean;
  description: string;
  constraints: string;
}

/** Top-level properties (and one level of nested objects) as rows. */
export function fieldRows(s: JsonSchema, prefix = "", depth = 0): FieldRow[] {
  const rows: FieldRow[] = [];
  const required = new Set(s.required ?? []);
  for (const [name, prop] of Object.entries(s.properties ?? {})) {
    const path = prefix === "" ? name : `${prefix}.${name}`;
    rows.push({
      path,
      type: typeOf(prop),
      required: required.has(name),
      description: prop.description ?? "",
      constraints: constraintsOf(prop),
    });
    if (depth < 1 && prop.properties) rows.push(...fieldRows(prop, path, depth + 1));
    if (depth < 1 && prop.items?.properties)
      rows.push(...fieldRows(prop.items, `${path}[]`, depth + 1));
  }
  return rows;
}
