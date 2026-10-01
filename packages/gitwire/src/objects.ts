/**
 * Loose git object encodings: blob/tree/commit bodies and their SHA-1 ids.
 * See git Documentation/gitformat-pack.txt "Object types" and the `git cat-file` formats.
 */
import { type Bytes, assertSha, concat, fromHex, sha1, text, toHex, utf8 } from "./bytes.js";
import { GitProtocolError } from "./errors.js";

export type ObjectType = "blob" | "tree" | "commit" | "tag";

export interface GitObject {
  type: ObjectType;
  data: Uint8Array;
}

/** SHA-1 of `"<type> <len>\0" + data` — identical to `git hash-object -t <type>`. */
export async function hashObject(obj: GitObject): Promise<string> {
  return toHex(await sha1(concat([utf8(`${obj.type} ${obj.data.length}\0`), obj.data])));
}

// ---------------------------------------------------------------------------------------------
// Trees

export interface TreeEntry {
  /** Octal mode as git writes it: "100644", "100755", "120000", "160000" or "40000" (tree). */
  mode: string;
  name: string;
  sha: string;
}

export const isTreeMode = (mode: string): boolean => mode === "40000" || mode === "040000";

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/**
 * Serialises a tree in git's canonical order: entries compared as raw bytes, with directory
 * names compared as if they ended in "/" (fsck reports anything else as `treeNotSorted`).
 */
export function encodeTree(entries: readonly TreeEntry[]): Bytes {
  const rows = entries.map((e) => {
    if (!/^[0-7]+$/.test(e.mode)) throw new TypeError(`invalid tree mode ${e.mode}`);
    if (!e.name || e.name === "." || e.name === ".." || /[/\0]/.test(e.name)) {
      throw new TypeError(`invalid tree entry name ${JSON.stringify(e.name)}`);
    }
    assertSha(e.sha, `tree entry ${e.name}`);
    const mode = e.mode === "040000" ? "40000" : e.mode;
    const name = utf8(e.name);
    const key = isTreeMode(mode) ? concat([name, utf8("/")]) : name;
    return { key, name, bytes: concat([utf8(`${mode} `), name, new Uint8Array([0]), fromHex(e.sha)]) };
  });
  rows.sort((a, b) => compareBytes(a.key, b.key));
  for (let i = 1; i < rows.length; i++) {
    if (compareBytes(rows[i - 1]!.name, rows[i]!.name) === 0) {
      throw new TypeError(`duplicate tree entry ${text(rows[i]!.name)}`);
    }
  }
  return concat(rows.map((r) => r.bytes));
}

export function decodeTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = space < 0 ? -1 : data.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new GitProtocolError("corrupt tree");
    entries.push({
      mode: text(data.subarray(pos, space)),
      name: text(data.subarray(space + 1, nul)),
      sha: toHex(data.subarray(nul + 1, nul + 21)),
    });
    pos = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Commits

export interface Signature {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  timestamp: number;
  /** "+HHMM" / "-HHMM". */
  timezone: string;
}

export interface Commit {
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  message: string;
  /** Headers after `committer` (encoding, gpgsig, mergetag…), kept so decode→encode is lossless. */
  extraHeaders?: Array<[string, string]>;
}

export function formatSignature(s: Signature): string {
  if (/[<>\n]/.test(s.name) || /[<>\n]/.test(s.email)) throw new TypeError("invalid signature");
  if (!/^[+-]\d{4}$/.test(s.timezone)) throw new TypeError(`invalid timezone ${s.timezone}`);
  if (!Number.isInteger(s.timestamp) || s.timestamp < 0) throw new TypeError("invalid timestamp");
  return `${s.name} <${s.email}> ${s.timestamp} ${s.timezone}`;
}

export function parseSignature(line: string): Signature {
  const m = /^(.*?) ?<([^<>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) throw new GitProtocolError(`invalid signature line: ${line}`);
  return { name: m[1]!, email: m[2]!, timestamp: Number(m[3]), timezone: m[4]! };
}

export function encodeCommit(c: Commit): Bytes {
  assertSha(c.tree, "tree");
  for (const p of c.parents) assertSha(p, "parent");
  const lines = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`)];
  lines.push(`author ${formatSignature(c.author)}`, `committer ${formatSignature(c.committer)}`);
  // Multi-line header values continue on lines that start with a single space.
  for (const [k, v] of c.extraHeaders ?? []) lines.push(`${k} ${v.replaceAll("\n", "\n ")}`);
  return utf8(`${lines.join("\n")}\n\n${c.message}`);
}

export function decodeCommit(data: Uint8Array): Commit {
  const s = text(data);
  const split = s.indexOf("\n\n");
  const head = split < 0 ? s : s.slice(0, split);
  const message = split < 0 ? "" : s.slice(split + 2);
  const headers: Array<[string, string]> = [];
  for (const line of head.split("\n")) {
    const last = headers[headers.length - 1];
    if (line.startsWith(" ") && last) last[1] += `\n${line.slice(1)}`;
    else {
      const sp = line.indexOf(" ");
      headers.push(sp < 0 ? [line, ""] : [line.slice(0, sp), line.slice(sp + 1)]);
    }
  }
  const one = (key: string): string => {
    const h = headers.find(([k]) => k === key);
    if (!h) throw new GitProtocolError(`commit without ${key} header`);
    return h[1];
  };
  const commit: Commit = {
    tree: one("tree"),
    parents: headers.filter(([k]) => k === "parent").map(([, v]) => v),
    author: parseSignature(one("author")),
    committer: parseSignature(one("committer")),
    message,
  };
  const extra = headers.filter(([k]) => !["tree", "parent", "author", "committer"].includes(k));
  if (extra.length) commit.extraHeaders = extra;
  return commit;
}
