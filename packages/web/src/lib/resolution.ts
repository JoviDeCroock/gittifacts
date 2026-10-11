/**
 * Reading a merge-queue resolution. The `conflict-resolution` evidence item carries a unified diff
 * from the mechanical merge (conflicted files with their markers) to the resolved files. Pure.
 *
 * For each conflict region it recovers what each side had (upstream = main, the Change, the common
 * base) and what lands, tagging every landed line with where it came from. A line found on neither
 * side was written by the resolver: that is what a person re-approving has to read.
 *
 * Markers: the queue's merge-attempt uses size 13 with labels (`<<<<<<<<<<<<< upstream`,
 * `||||||||||||| base`, `=============`, `>>>>>>>>>>>>> change`); git's default is size 7. Any run
 * of 7 or more is accepted, as the item does not record the size.
 */

export type LineOrigin = "upstream" | "change" | "both" | "base" | "resolver";

export interface LandedLine {
  text: string;
  origin: LineOrigin;
}

export interface ResolvedRegion {
  upstream: string[];
  base: string[] | null;
  change: string[];
  lands: LandedLine[];
  /** Unchanged lines inside the region the diff did not show (between two hunks). */
  hidden: number;
}

export interface OutsideEdit {
  kind: "add" | "del";
  text: string;
}

export interface ResolvedFile {
  path: string;
  regions: ResolvedRegion[];
  /** Edits outside any conflict region: no one approved these lines. */
  outside: OutsideEdit[];
}

type Side = "upstream" | "base" | "change";
type Marker = "open" | "base" | "mid" | "close";

const MARKER: [Marker, RegExp][] = [
  ["open", /^<{7,}(?: .*)?$/],
  ["base", /^\|{7,}(?: .*)?$/],
  ["mid", /^={7,}$/],
  ["close", /^>{7,}(?: .*)?$/],
];

function markerOf(text: string): Marker | null {
  for (const [m, re] of MARKER) if (re.test(text)) return m;
  return null;
}

function originOf(text: string, r: ResolvedRegion): LineOrigin {
  const up = r.upstream.includes(text);
  const ch = r.change.includes(text);
  if (up && ch) return "both";
  if (up) return "upstream";
  if (ch) return "change";
  if (r.base?.includes(text)) return "base";
  return "resolver";
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function emptyRegion(): ResolvedRegion {
  return { upstream: [], base: null, change: [], lands: [], hidden: 0 };
}

/** Parse one file's diff body (the lines after its `+++` header). */
function parseFile(path: string, lines: string[]): ResolvedFile {
  const file: ResolvedFile = { path, regions: [], outside: [] };
  let side: Side | null = null;
  let region: ResolvedRegion | null = null;
  /** Added lines seen outside a region, waiting to see whether a region follows. */
  let pendingAdds: string[] = [];
  /** The region that just closed: added lines right after it are its replacement. */
  let justClosed: ResolvedRegion | null = null;
  let prevOldEnd: number | null = null;
  const flushOutside = () => {
    for (const text of pendingAdds) file.outside.push({ kind: "add", text });
    pendingAdds = [];
  };
  for (const raw of lines) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      const oldStart = Number(hunk[1]);
      const oldLines = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (region !== null && prevOldEnd !== null)
        region.hidden += Math.max(0, oldStart - prevOldEnd);
      if (region === null) flushOutside();
      prevOldEnd = oldStart + oldLines;
      justClosed = null;
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const kind = raw[0];
    const text = raw.slice(1);
    if (kind === "+") {
      if (region !== null) region.lands.push({ text, origin: "resolver" });
      else if (justClosed !== null) justClosed.lands.push({ text, origin: "resolver" });
      else pendingAdds.push(text);
      continue;
    }
    if (kind !== " " && kind !== "-") continue;
    const marker = markerOf(text);
    if (region === null) {
      if (marker === "open") {
        region = emptyRegion();
        for (const t of pendingAdds) region.lands.push({ text: t, origin: "resolver" });
        pendingAdds = [];
        side = "upstream";
        justClosed = null;
        continue;
      }
      flushOutside();
      justClosed = null;
      if (kind === "-") file.outside.push({ kind: "del", text });
      continue;
    }
    if (marker === "base") {
      region.base = [];
      side = "base";
      continue;
    }
    if (marker === "mid") {
      side = "change";
      continue;
    }
    if (marker === "close") {
      file.regions.push(region);
      justClosed = region;
      region = null;
      side = null;
      continue;
    }
    // A line of one side: kept (context) lands too; a deleted one does not.
    if (side === "base") region.base?.push(text);
    else if (side === "change") region.change.push(text);
    else region.upstream.push(text);
    if (kind === " ") region.lands.push({ text, origin: "resolver" });
  }
  flushOutside();
  if (region !== null) file.regions.push(region); // cut off (a truncated diff)
  for (const r of file.regions)
    r.lands = r.lands.map((l) => ({ text: l.text, origin: originOf(l.text, r) }));
  return file;
}

/** Split a multi-file unified diff and parse every file. */
export function parseResolution(diff: string): ResolvedFile[] {
  const files: ResolvedFile[] = [];
  let path: string | null = null;
  let body: string[] = [];
  const done = () => {
    if (path !== null) files.push(parseFile(path, body));
    body = [];
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      done();
      const m = / b\/(.+)$/.exec(line);
      path = m?.[1] ?? line.slice("diff --git ".length);
      continue;
    }
    if (path === null) continue;
    if (/^(---|\+\+\+) /.test(line) && body.every((l) => !l.startsWith("@@"))) {
      const m = /^\+\+\+ b\/(.+)$/.exec(line);
      if (m?.[1]) path = m[1];
      continue;
    }
    if (
      /^(index |new file mode|deleted file mode|old mode|new mode|similarity|rename )/.test(line) &&
      body.length === 0
    )
      continue;
    if (line === "" && body.length === 0) continue;
    body.push(line);
  }
  done();
  return files;
}

/** Lines the resolver wrote (found on no side), across all files. */
export function resolverLineCount(files: ResolvedFile[]): number {
  let n = 0;
  for (const f of files)
    for (const r of f.regions) n += r.lands.filter((l) => l.origin === "resolver").length;
  return n;
}
