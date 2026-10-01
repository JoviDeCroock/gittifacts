/**
 * Canonical JSON (RFC 8785, "JCS").
 *
 * - Object keys sorted by UTF-16 code units, no insignificant whitespace.
 * - Numbers use ECMAScript `Number#toString` (so `1e21` → `1e+21`, `-0` → `0`).
 * - Strings use the ECMAScript JSON escaping rules (which JCS adopts).
 * - `undefined` object members are dropped (like `JSON.stringify`); everything
 *   else that has no JSON meaning is rejected instead of being silently changed:
 *   NaN/±Infinity, functions, symbols, bigints, `undefined` in arrays or at the
 *   top level, lone UTF-16 surrogates (not I-JSON), cycles, Map/Set/typed arrays.
 * - Objects with a `toJSON` method (e.g. `Date`) are serialized through it, as
 *   `JSON.stringify` would, so a value and its JSON round-trip canonicalize the same.
 *
 * The same traversal also powers {@link stableStringify}, a pretty-printed
 * variant with identical key ordering, used for human-readable git notes.
 */
import { utf8Encode } from "./encoding.js";

export class CanonicalizationError extends Error {
  override readonly name = "CanonicalizationError";
  /** JSON-pointer-ish location of the offending value, e.g. `/items/0/note`. */
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} at ${path === "" ? "<root>" : path}`);
    this.path = path;
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function compareUtf16(a: string, b: string): number {
  // String relational comparison in ECMAScript is by UTF-16 code units, which is
  // exactly what RFC 8785 §3.2.3 requires (not code points, not locale order).
  return a < b ? -1 : a > b ? 1 : 0;
}

function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function serializeString(s: string, path: string): string {
  if (LONE_SURROGATE.test(s)) {
    throw new CanonicalizationError("lone UTF-16 surrogate in string", path);
  }
  return JSON.stringify(s);
}

function serializeNumber(n: number, path: string): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalizationError(`non-finite number ${String(n)}`, path);
  }
  // Number#toString is the ES "Number::toString" algorithm RFC 8785 §3.2.2.3 points to.
  // String(-0) === "0", which is what JCS mandates.
  return String(n);
}

function isRejectedObject(v: object): string | null {
  if (v instanceof Map) return "Map";
  if (v instanceof Set) return "Set";
  if (v instanceof WeakMap) return "WeakMap";
  if (v instanceof WeakSet) return "WeakSet";
  if (ArrayBuffer.isView(v)) return "typed array / DataView";
  if (v instanceof ArrayBuffer) return "ArrayBuffer";
  if (v instanceof Promise) return "Promise";
  return null;
}

interface Layout {
  /** Spaces per indent level; 0 = compact canonical form. */
  indent: number;
}

function hasToJSON(v: object): v is { toJSON: (key: string) => unknown } {
  return typeof (v as { toJSON?: unknown }).toJSON === "function";
}

function serialize(
  value: unknown,
  path: string,
  key: string,
  seen: Set<object>,
  layout: Layout,
  depth: number,
): string | undefined {
  let v = value;
  if (v !== null && typeof v === "object" && hasToJSON(v)) {
    v = v.toJSON(key);
  }
  switch (typeof v) {
    case "undefined":
      return undefined;
    case "boolean":
      return v ? "true" : "false";
    case "number":
      return serializeNumber(v, path);
    case "string":
      return serializeString(v, path);
    case "bigint":
      throw new CanonicalizationError("bigint is not representable in JSON", path);
    case "symbol":
      throw new CanonicalizationError("symbol is not representable in JSON", path);
    case "function":
      throw new CanonicalizationError("function is not representable in JSON", path);
    case "object":
      break;
  }
  if (v === null) return "null";
  const obj = v as object;
  const rejected = isRejectedObject(obj);
  if (rejected) throw new CanonicalizationError(`${rejected} is not representable in JSON`, path);
  if (seen.has(obj)) throw new CanonicalizationError("cyclic structure", path);
  seen.add(obj);

  const nl = layout.indent > 0 ? "\n" : "";
  const pad = layout.indent > 0 ? " ".repeat(layout.indent * (depth + 1)) : "";
  const padEnd = layout.indent > 0 ? " ".repeat(layout.indent * depth) : "";
  const colon = layout.indent > 0 ? ": " : ":";

  let out: string;
  if (Array.isArray(obj)) {
    const parts: string[] = [];
    for (let i = 0; i < obj.length; i++) {
      const p = pointer(path, i);
      const s = serialize(obj[i], p, String(i), seen, layout, depth + 1);
      if (s === undefined) {
        throw new CanonicalizationError("undefined is not allowed in arrays", p);
      }
      parts.push(pad + s);
    }
    out = parts.length === 0 ? "[]" : `[${nl}${parts.join(`,${nl}`)}${nl}${padEnd}]`;
  } else {
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf16);
    const parts: string[] = [];
    for (const k of keys) {
      const p = pointer(path, k);
      const s = serialize(record[k], p, k, seen, layout, depth + 1);
      if (s === undefined) continue; // JSON.stringify drops undefined members
      parts.push(`${pad}${serializeString(k, p)}${colon}${s}`);
    }
    out = parts.length === 0 ? "{}" : `{${nl}${parts.join(`,${nl}`)}${nl}${padEnd}}`;
  }
  seen.delete(obj);
  return out;
}

/** RFC 8785 canonical JSON text. Throws {@link CanonicalizationError} on non-JSON input. */
export function canonicalize(value: unknown): string {
  const s = serialize(value, "", "", new Set(), { indent: 0 }, 0);
  if (s === undefined) throw new CanonicalizationError("undefined is not representable", "");
  return s;
}

/** UTF-8 bytes of {@link canonicalize}. This is what gets hashed and signed. */
export function canonicalBytes(value: unknown): Uint8Array {
  return utf8Encode(canonicalize(value));
}

/**
 * Pretty-printed JSON with canonical (sorted) key order and the same strictness
 * as {@link canonicalize}. Deterministic, so it diffs and merges well in git.
 */
export function stableStringify(value: unknown, indent = 2): string {
  const s = serialize(value, "", "", new Set(), { indent: Math.max(0, Math.floor(indent)) }, 0);
  if (s === undefined) throw new CanonicalizationError("undefined is not representable", "");
  return s;
}
