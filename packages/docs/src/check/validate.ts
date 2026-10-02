/**
 * JSON Schema validation for samples (tool-call arguments, JSON blocks), tolerant of
 * placeholders: a string such as "<changeId>" or "https://<host>/x" stands for any valid value,
 * so pattern, length and format rules don't apply to it. Enums and types still do.
 */
import Ajv, { type ErrorObject } from "ajv";

const ajv = new Ajv({ strict: false, allErrors: true });
const compiled = new WeakMap<object, ReturnType<typeof ajv.compile>>();

export const PLACEHOLDER = /<[^<>\s][^<>]*>/;

const STRING_RULES = new Set(["pattern", "minLength", "maxLength", "format"]);

function valueAt(data: unknown, pointer: string): unknown {
  let v: unknown = data;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

export interface SampleError {
  path: string;
  message: string;
}

export function validateSample(schema: object, data: unknown): SampleError[] {
  let validate = compiled.get(schema);
  if (validate === undefined) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  if (validate(data)) return [];
  return (validate.errors ?? [])
    .filter((e: ErrorObject) => {
      if (!STRING_RULES.has(e.keyword)) return true;
      const v = valueAt(data, e.instancePath);
      return !(typeof v === "string" && PLACEHOLDER.test(v));
    })
    .map((e: ErrorObject) => ({
      path: e.instancePath === "" ? "(root)" : e.instancePath,
      message: `${e.message ?? "invalid"}${e.params && "allowedValues" in e.params ? ` (${(e.params.allowedValues as unknown[]).join(", ")})` : ""}`,
    }));
}
