/**
 * Lockfile diffs, checked against the manifest's recorded bumps.
 *
 * A patch bump in package.json can ride along with a rewritten lockfile entry (a resolution or
 * integrity pointing at an attacker's tarball, or new packages). This module explains every
 * lockfile change, or says why it can't: each changed entry must be one version bump of a package
 * the manifest bumped, a patch bump, re-resolved from the registry, with nothing else in the
 * entry changed; references to it may follow the new version; nothing is added or removed.
 * Transitive updates (the bumped package's own new dependencies) are not explained: they come
 * back as problems, which keeps the Change out of Lane 0 (unknown → escalate).
 *
 * Supported: pnpm-lock.yaml (lockfile v6 and v9) and package-lock.json / npm-shrinkwrap.json
 * (lockfile v2 and v3). Other formats (yarn.lock, bun.lock, bun.lockb) are reported unsupported.
 */
import { semverBump } from "./semver.js";

export interface LockfileChange {
  lockfile: string;
  name: string;
  from: string;
  to: string;
}

export interface LockfileCheck {
  changes: LockfileChange[];
  /** Why some lockfile change is not explained by the recorded bumps (empty = all explained). */
  problems: string[];
}

/** A manifest change (from the dependency diff): `from`/`to` are the spec strings. */
export interface ManifestBump {
  name: string;
  from: string;
  to: string;
  bump: string;
}

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** One lock version bump of a package the manifest patch-bumped, or why it isn't. */
function checkBump(
  name: string,
  from: string,
  to: string,
  bumps: readonly ManifestBump[],
): string | null {
  if (!bumps.some((b) => b.name === name && b.bump === "patch"))
    return `${name} ${from} → ${to} changed in the lockfile, but no manifest patch bump records it`;
  if (!EXACT.test(from) || !EXACT.test(to))
    return `${name} ${from} → ${to} is not a registry version`;
  if (semverBump(from, to) !== "patch") return `${name} ${from} → ${to} is not a patch bump`;
  return null;
}

/** The manifest records this exact spec change for `name`. */
function specBumped(name: string, from: unknown, to: unknown, bumps: readonly ManifestBump[]) {
  return bumps.some((b) => b.name === name && b.from === from && b.to === to);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function lockfileChanges(
  path: string,
  base: string | null,
  head: string | null,
  bumps: readonly ManifestBump[],
): LockfileCheck {
  if (base === head) return { changes: [], problems: [] };
  if (base === null || head === null)
    return {
      changes: [],
      problems: [`${path}: the lockfile was ${base === null ? "added" : "deleted"}`],
    };
  const name = basename(path);
  if (name === "pnpm-lock.yaml") return pnpmChanges(path, base, head, bumps);
  if (name === "package-lock.json" || name === "npm-shrinkwrap.json")
    return npmChanges(path, base, head, bumps);
  return {
    changes: [],
    problems: [`${path}: ${name} changes can't be checked (unsupported lockfile format)`],
  };
}

// ---------------------------------------------------------------- package-lock.json

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** Stable serialization (sorted keys) for comparing JSON values. */
function stable(v: Json | undefined): string {
  if (v === undefined) return "undefined";
  if (!isObj(v)) return Array.isArray(v) ? `[${v.map(stable).join(",")}]` : JSON.stringify(v);
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
    .join(",")}}`;
}

/** Own property (never one inherited from Object.prototype, e.g. "constructor"). */
const own = (o: Obj, k: string): Json | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

function without(o: Obj, keys: readonly string[]): Obj {
  // A null prototype keeps a "__proto__" key an own property, so it is compared too.
  const out: Obj = Object.create(null) as Obj;
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out;
}

const DEP_MAPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** Legacy v1/v2 `dependencies` tree, flattened to `node_modules/a/node_modules/b` paths. */
function flattenLegacy(deps: Json | undefined, prefix: string, out: Map<string, Obj>): boolean {
  if (deps === undefined) return true;
  if (!isObj(deps)) return false;
  for (const [name, entry] of Object.entries(deps)) {
    if (!isObj(entry)) return false;
    const path = `${prefix}node_modules/${name}`;
    out.set(path, without(entry, ["dependencies"]));
    if (!flattenLegacy(own(entry, "dependencies"), `${path}/`, out)) return false;
  }
  return true;
}

function parseNpm(text: string): { lock: Obj; packages: Map<string, Obj> } | string {
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch {
    return "not valid JSON";
  }
  if (!isObj(lock)) return "not a JSON object";
  const version = own(lock, "lockfileVersion");
  if (version !== 2 && version !== 3)
    return `lockfileVersion ${String(version)} is not supported (2 or 3)`;
  const pk = own(lock, "packages");
  if (!isObj(pk)) return "no packages map";
  const packages = new Map<string, Obj>();
  for (const [k, v] of Object.entries(pk)) {
    if (!isObj(v)) return `packages["${k}"] is not an object`;
    packages.set(k, v);
  }
  return { lock, packages };
}

/** Compare one path-keyed entry map (v2/v3 `packages`, or the flattened legacy tree). */
function compareNpmEntries(
  path: string,
  base: Map<string, Obj>,
  head: Map<string, Obj>,
  bumps: readonly ManifestBump[],
  out: LockfileCheck,
  record: boolean,
): void {
  const added = [...head.keys()].filter((k) => !base.has(k));
  const removed = [...base.keys()].filter((k) => !head.has(k));
  if (added.length > 0)
    out.problems.push(`${path}: new lock entries ${added.slice(0, 10).join(", ")}`);
  if (removed.length > 0)
    out.problems.push(`${path}: removed lock entries ${removed.slice(0, 10).join(", ")}`);
  for (const [key, b] of base) {
    const h = head.get(key);
    if (h === undefined || stable(b) === stable(h)) continue;
    const at = key.lastIndexOf("node_modules/");
    if (at === -1) {
      // The root or a workspace package: only its bumped specs may change.
      if (stable(without(b, DEP_MAPS)) !== stable(without(h, DEP_MAPS)))
        out.problems.push(`${path}: "${key || "(root)"}" changed beyond its dependency specs`);
      for (const section of DEP_MAPS) {
        const bs = own(b, section);
        const hs = own(h, section);
        const bm: Obj = isObj(bs) ? bs : {};
        const hm: Obj = isObj(hs) ? hs : {};
        for (const name of new Set([...Object.keys(bm), ...Object.keys(hm)]))
          if (
            own(bm, name) !== own(hm, name) &&
            !specBumped(name, own(bm, name), own(hm, name), bumps)
          )
            out.problems.push(
              `${path}: "${key || "(root)"}" ${section}.${name} changed unrecorded`,
            );
      }
      continue;
    }
    const alias = own(h, "name");
    const name = typeof alias === "string" ? alias : key.slice(at + "node_modules/".length);
    const from = String(own(b, "version"));
    const to = String(own(h, "version"));
    const bResolved = own(b, "resolved");
    const hIntegrity = own(h, "integrity");
    const bad = checkBump(name, from, to, bumps);
    if (bad !== null) {
      out.problems.push(`${path}: ${bad}`);
      continue;
    }
    // Same registry, same tarball path, only the version in the file name changed.
    const resolvedOk =
      typeof bResolved === "string" &&
      bResolved.startsWith("https://") &&
      bResolved.endsWith(`-${from}.tgz`) &&
      own(h, "resolved") === `${bResolved.slice(0, -`-${from}.tgz`.length)}-${to}.tgz`;
    if (!resolvedOk)
      out.problems.push(`${path}: ${name}@${to} does not resolve from the registry it came from`);
    if (typeof hIntegrity !== "string" || hIntegrity === own(b, "integrity"))
      out.problems.push(`${path}: ${name}@${to} has no new integrity`);
    const rest = ["version", "resolved", "integrity"];
    if (stable(without(b, rest)) !== stable(without(h, rest)))
      out.problems.push(
        `${path}: ${name}@${to} changed more than its version (dependencies, scripts, …)`,
      );
    if (record) out.changes.push({ lockfile: path, name, from, to });
  }
}

function npmChanges(
  path: string,
  baseText: string,
  headText: string,
  bumps: readonly ManifestBump[],
) {
  const out: LockfileCheck = { changes: [], problems: [] };
  const b = parseNpm(baseText);
  const h = parseNpm(headText);
  if (typeof b === "string" || typeof h === "string") {
    out.problems.push(`${path}: ${typeof b === "string" ? `base ${b}` : `head ${h as string}`}`);
    return out;
  }
  const top = ["packages", "dependencies"];
  if (stable(without(b.lock, top)) !== stable(without(h.lock, top)))
    out.problems.push(`${path}: top-level fields changed`);
  compareNpmEntries(path, b.packages, h.packages, bumps, out, true);
  const lb = new Map<string, Obj>();
  const lh = new Map<string, Obj>();
  if (
    !flattenLegacy(own(b.lock, "dependencies"), "", lb) ||
    !flattenLegacy(own(h.lock, "dependencies"), "", lh)
  )
    out.problems.push(`${path}: the legacy dependencies tree is malformed`);
  else compareNpmEntries(path, lb, lh, bumps, out, false);
  return out;
}

// ---------------------------------------------------------------- pnpm-lock.yaml

/** A block-mapping node of the YAML subset pnpm writes (`key: value`, nesting, `- item`). */
interface YNode {
  key: string;
  value: string | null;
  children: YNode[];
}

const KEY_LINE = /^(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"|(.+?)):(?: (.*))?$/;

/** Parse the indentation tree; anything outside the subset is an error (unknown → escalate). */
function parseYamlTree(text: string): YNode[] | string {
  const root: YNode = { key: "", value: null, children: [] };
  const stack: { indent: number; node: YNode }[] = [{ indent: -1, node: root }];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (/^\s*\t/.test(line)) return `line ${i + 1}: tab indentation`;
    const body = line.slice(indent).trimEnd();
    if (indent === 0 && (body === "---" || body === "..."))
      return `line ${i + 1}: multiple documents`;
    let node: YNode;
    if (body === "-" || body.startsWith("- "))
      node = { key: "-", value: body.slice(2), children: [] };
    else {
      const m = KEY_LINE.exec(body);
      if (m === null) return `line ${i + 1}: not a key`;
      const key = m[1] !== undefined ? m[1].replaceAll("''", "'") : (m[2] ?? m[3] ?? "");
      const raw = m[4] ?? null;
      // A plain single-quoted scalar ('^1.2.3', '9.0') means its text.
      const value =
        raw !== null && /^'(?:[^']|'')*'$/.test(raw) ? raw.slice(1, -1).replaceAll("''", "'") : raw;
      if (raw !== null && /^[|>]/.test(raw)) return `line ${i + 1}: block scalar`;
      node = { key, value: value === "" ? null : value, children: [] };
    }
    while (stack[stack.length - 1]!.indent >= indent) stack.pop();
    stack[stack.length - 1]!.node.children.push(node);
    stack.push({ indent, node });
  }
  return root.children;
}

function ser(n: YNode): string {
  return `${JSON.stringify(n.key)}:${JSON.stringify(n.value)}{${n.children.map(ser).join(",")}}`;
}

function child(nodes: readonly YNode[], key: string): YNode | undefined {
  return nodes.find((n) => n.key === key);
}

/** `name@version(peers)` (v9) or `/name@version(peers)` (v6) → its parts. */
function entryKey(key: string): { name: string; version: string } | null {
  const k = key.startsWith("/") ? key.slice(1) : key;
  const at = k.indexOf("@", k.startsWith("@") ? 1 : 0);
  if (at <= 0) return null;
  const rest = k.slice(at + 1);
  const paren = rest.indexOf("(");
  return { name: k.slice(0, at), version: paren === -1 ? rest : rest.slice(0, paren) };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Pair {
  name: string;
  from: string;
  to: string;
}

/** Rewrite references to each bumped package's old version to its new one. */
function substitution(pairs: readonly Pair[]) {
  const res = pairs.map((p) => ({
    p,
    re: new RegExp(`(^|[\\s/('])${escapeRe(p.name)}@${escapeRe(p.from)}(?=$|[\\s()':])`, "g"),
    value: new RegExp(`^${escapeRe(p.from)}(?=$|\\()`),
  }));
  const str = (s: string) => res.reduce((t, r) => t.replace(r.re, `$1${r.p.name}@${r.p.to}`), s);
  const node = (n: YNode): YNode => {
    let value = n.value === null ? null : str(n.value);
    for (const r of res)
      if (value !== null && n.key === r.p.name) value = value.replace(r.value, r.p.to);
    return { key: str(n.key), value, children: n.children.map(node) };
  };
  return { str, node };
}

const ENTRY_SECTIONS = ["packages", "snapshots"];
const IMPORTER_DEPS = ["dependencies", "devDependencies", "optionalDependencies"];
const REGISTRY_RESOLUTION = /^\{integrity: [A-Za-z0-9+/=_-]+\}$/;

/** Importers by path; a v6 single-project lockfile keeps its dependency maps at the top level. */
function importersOf(tree: readonly YNode[]): Map<string, YNode[]> {
  const out = new Map<string, YNode[]>();
  for (const imp of child(tree, "importers")?.children ?? []) out.set(imp.key, imp.children);
  const top = tree.filter((n) => IMPORTER_DEPS.includes(n.key));
  if (top.length > 0) out.set(".", [...(out.get(".") ?? []), ...top]);
  return out;
}

function versionsByName(tree: readonly YNode[], out: LockfileCheck, path: string) {
  const byName = new Map<string, Set<string>>();
  for (const section of ENTRY_SECTIONS)
    for (const e of child(tree, section)?.children ?? []) {
      const k = entryKey(e.key);
      if (k === null) {
        out.problems.push(`${path}: can't read lock entry "${e.key}"`);
        continue;
      }
      const set = byName.get(k.name) ?? new Set<string>();
      set.add(k.version);
      byName.set(k.name, set);
    }
  return byName;
}

function pnpmChanges(
  path: string,
  baseText: string,
  headText: string,
  bumps: readonly ManifestBump[],
) {
  const out: LockfileCheck = { changes: [], problems: [] };
  const bt = parseYamlTree(baseText);
  const ht = parseYamlTree(headText);
  if (typeof bt === "string" || typeof ht === "string") {
    out.problems.push(`${path}: ${typeof bt === "string" ? `base ${bt}` : `head ${ht as string}`}`);
    return out;
  }
  const version = child(bt, "lockfileVersion")?.value ?? "";
  if (!/^(6|7|8|9)\.\d+$/.test(version)) {
    out.problems.push(`${path}: lockfileVersion ${version || "?"} is not supported (6 or 9)`);
    return out;
  }
  // Settings, overrides, patches, catalogs…: anything that isn't an entry must not change.
  const structural = new Set(["importers", ...ENTRY_SECTIONS, ...IMPORTER_DEPS]);
  const rest = (t: readonly YNode[]) =>
    t
      .filter((n) => !structural.has(n.key))
      .map(ser)
      .join("\n");
  if (rest(bt) !== rest(ht)) out.problems.push(`${path}: settings or overrides changed`);

  // Which packages changed version: one bump each, of a package the manifest patch-bumped.
  const bv = versionsByName(bt, out, path);
  const hv = versionsByName(ht, out, path);
  const pairs: Pair[] = [];
  for (const name of new Set([...bv.keys(), ...hv.keys()])) {
    const b = bv.get(name) ?? new Set<string>();
    const h = hv.get(name) ?? new Set<string>();
    const removed = [...b].filter((v) => !h.has(v));
    const added = [...h].filter((v) => !b.has(v));
    if (removed.length === 0 && added.length === 0) continue;
    if (removed.length !== 1 || added.length !== 1) {
      out.problems.push(
        `${path}: ${name} ${removed.join(", ") || "(none)"} → ${added.join(", ") || "(none)"} is not one version bump (new or transitive packages)`,
      );
      continue;
    }
    const bad = checkBump(name, removed[0]!, added[0]!, bumps);
    if (bad !== null) out.problems.push(`${path}: ${bad}`);
    else pairs.push({ name, from: removed[0]!, to: added[0]! });
  }
  const sub = substitution(pairs);

  for (const section of ENTRY_SECTIONS) {
    const base = new Map(
      (child(bt, section)?.children ?? []).map((e) => [sub.str(e.key), sub.node(e)]),
    );
    const head = new Map((child(ht, section)?.children ?? []).map((e) => [e.key, e]));
    for (const key of new Set([...base.keys(), ...head.keys()])) {
      const b = base.get(key);
      const h = head.get(key);
      if (b === undefined || h === undefined) {
        out.problems.push(
          `${path}: ${section} entry ${key} ${b === undefined ? "added" : "removed"}`,
        );
        continue;
      }
      if (ser(b) === ser(h)) continue;
      const k = entryKey(key);
      const bumped = k !== null && pairs.some((p) => p.name === k.name && p.to === k.version);
      const strip = (n: YNode) => ({
        ...n,
        children: n.children.filter((c) => c.key !== "resolution"),
      });
      const resolution = child(h.children, "resolution")?.value ?? "";
      if (!bumped || ser(strip(b)) !== ser(strip(h)))
        out.problems.push(`${path}: ${section} entry ${key} changed more than a version bump`);
      else if (section === "packages" && !REGISTRY_RESOLUTION.test(resolution))
        out.problems.push(
          `${path}: ${key} does not resolve from the registry (${resolution.slice(0, 200)})`,
        );
    }
  }

  const bi = importersOf(bt);
  const hi = importersOf(ht);
  for (const imp of new Set([...bi.keys(), ...hi.keys()])) {
    const b = bi.get(imp);
    const h = hi.get(imp);
    if (b === undefined || h === undefined) {
      out.problems.push(`${path}: importer ${imp} ${b === undefined ? "added" : "removed"}`);
      continue;
    }
    const other = (t: YNode[]) =>
      t
        .filter((n) => !IMPORTER_DEPS.includes(n.key))
        .map(ser)
        .join("\n");
    if (other(b) !== other(h)) out.problems.push(`${path}: importer ${imp} changed`);
    for (const section of IMPORTER_DEPS) {
      const bm = new Map((child(b, section)?.children ?? []).map((d) => [d.key, d]));
      const hm = new Map((child(h, section)?.children ?? []).map((d) => [d.key, d]));
      for (const name of new Set([...bm.keys(), ...hm.keys()])) {
        const bd = bm.get(name);
        const hd = hm.get(name);
        // Peer suffixes may follow a bumped package: `1.0.0(hono@4.1.1)` → `1.0.0(hono@4.1.2)`.
        if (bd !== undefined && hd !== undefined && ser(sub.node(bd)) === ser(hd)) continue;
        const spec = (d: YNode | undefined) =>
          d === undefined ? undefined : child(d.children, "specifier")?.value;
        const ver = (d: YNode | undefined) =>
          d === undefined ? undefined : child(d.children, "version")?.value;
        const explained =
          bd !== undefined &&
          hd !== undefined &&
          bd.children.length === 2 &&
          hd.children.length === 2 &&
          specBumped(name, spec(bd), spec(hd), bumps) &&
          sub.node({ key: name, value: ver(bd) ?? null, children: [] }).value === ver(hd);
        if (!explained)
          out.problems.push(`${path}: importer ${imp} ${section}.${name} changed unrecorded`);
      }
    }
  }
  for (const p of pairs) out.changes.push({ lockfile: path, name: p.name, from: p.from, to: p.to });
  return out;
}
