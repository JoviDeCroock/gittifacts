/**
 * Classify a dependency spec change (npm range strings) as a semver bump.
 *
 * Only "simple" specs are compared: an exact version, `=`/`v`-prefixed, `^x.y.z`,
 * `~x.y.z`, and partials (`1`, `1.2`, `1.x`, `^1.2`). Everything else — compound ranges,
 * `workspace:`, `file:`, `link:`, git/http URLs, GitHub shorthands, dist-tags, `*` —
 * is "other", as is a change of range operator (e.g. `1.2.3` → `^1.2.3`) or a change
 * that leaves the version itself identical.
 *
 * The level is the magnitude of the change in either direction (a major downgrade is
 * "major"). For 0.x versions the left-most non-zero component is treated as the major
 * one, matching npm caret semantics: 0.2.x → 0.3.0 is "major", 0.0.3 → 0.0.4 is "major".
 * A change to a different prerelease of the same x.y.z, or to a prerelease target at a
 * non-major level, is "prerelease".
 */
import type { SemverBump } from "../schema.js";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const VERSION_RE =
  /^v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*|[xX*]))?(?:\.(0|[1-9]\d*|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parse `1.2.3`, `v1.2.3-rc.1+build`, and partials `1`, `1.2`, `1.x` (missing parts = 0). */
export function parseVersion(v: string): SemVer | null {
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  const num = (s: string | undefined): number =>
    s === undefined || /[xX*]/.test(s) ? 0 : Number(s);
  return {
    major: Number(m[1]),
    minor: num(m[2]),
    patch: num(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

export type RangeOperator = "exact" | "caret" | "tilde";

/** A spec we can reason about, or null. */
export function parseSimpleRange(spec: string): { op: RangeOperator; version: SemVer } | null {
  const s = spec.trim();
  if (s === "" || /[\s|<>]/.test(s)) return null;
  let op: RangeOperator = "exact";
  let rest = s;
  if (rest.startsWith("^")) {
    op = "caret";
    rest = rest.slice(1);
  } else if (rest.startsWith("~")) {
    op = "tilde";
    rest = rest.slice(1);
  } else if (rest.startsWith("=")) {
    rest = rest.slice(1);
  }
  const version = parseVersion(rest);
  return version ? { op, version } : null;
}

function samePrerelease(a: SemVer, b: SemVer): boolean {
  return (
    a.prerelease.length === b.prerelease.length &&
    a.prerelease.every((p, i) => p === b.prerelease[i])
  );
}

function splitAlias(spec: string): { name: string; spec: string } | null {
  if (!spec.startsWith("npm:")) return null;
  const body = spec.slice(4);
  const at = body.lastIndexOf("@");
  if (at <= 0) return { name: body, spec: "" };
  return { name: body.slice(0, at), spec: body.slice(at + 1) };
}

export function semverBump(from: string, to: string): SemverBump {
  const fa = splitAlias(from.trim());
  const ta = splitAlias(to.trim());
  if (fa || ta) {
    if (!fa || !ta || fa.name !== ta.name) return "other";
    return semverBump(fa.spec, ta.spec);
  }
  const a = parseSimpleRange(from);
  const b = parseSimpleRange(to);
  if (!a || !b || a.op !== b.op) return "other";
  const x = a.version;
  const y = b.version;

  let level: "major" | "minor" | "patch" | null = null;
  if (x.major !== y.major) level = "major";
  else if (x.minor !== y.minor) level = x.major === 0 ? "major" : "minor";
  else if (x.patch !== y.patch) level = x.major === 0 && x.minor === 0 ? "major" : "patch";

  if (level === null) return samePrerelease(x, y) ? "other" : "prerelease";
  if (level !== "major" && y.prerelease.length > 0) return "prerelease";
  return level;
}
