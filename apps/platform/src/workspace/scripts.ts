/**
 * Shell scripts the workspace runs in the sandbox image (`sh`, GNU coreutils, git ≥ 2.39). Pure
 * strings: the inputs always arrive as positional arguments or environment variables, never
 * interpolated into the script text.
 *
 * Every script that touches a path resolves it with `realpath -m` and refuses anything that
 * leaves /workspace (symlinks included), on top of the Worker-side check in model.ts.
 */

export const WS_MARKER = "::ws::";

/** Lines shared by path-taking scripts: `$r` is the resolved absolute path of `$1`. */
const RESOLVE = [
  'r="$(realpath -m -- "/workspace/$1")"',
  'case "$r" in /workspace/*) ;; *) echo "path resolves outside the workspace" >&2; exit 3;; esac',
  'case "$r" in /workspace/.git|/workspace/.git/*) echo "path is inside .git" >&2; exit 3;; esac',
];

/**
 * Brings /workspace to `$WS_HEAD` on branch `$WS_BRANCH` of the fork `$WS_REMOTE`:
 * a blobless clone (commits and trees first, blobs of the checked-out tree fetched by the
 * checkout itself) plus the base commit with blobs, so `ws_diff` works without credentials.
 * Starting from a CI dependency snapshot, untracked files such as node_modules are kept.
 * Auth: `GIT_CONFIG_*` env only (this exec), never argv or .git/config.
 */
export const CHECKOUT_SCRIPT = [
  "set -eu",
  "mkdir -p /workspace",
  "cd /workspace",
  "if [ ! -d .git ]; then git init -q .; fi",
  "git remote remove origin >/dev/null 2>&1 || true",
  'git remote add origin "$WS_REMOTE"',
  'git fetch -q --no-tags --depth=50 --filter=blob:none origin "$WS_HEAD"',
  'if [ "$WS_BASE" != "$WS_HEAD" ]; then git fetch -q --no-tags --no-filter --depth=1 origin "$WS_BASE"; fi',
  'git -c advice.detachedHead=false checkout -q --force -B "$WS_BRANCH" "$WS_HEAD"',
  `printf '%s{"head":"%s"}\\n' '${WS_MARKER}' "$(git rev-parse HEAD)"`,
].join("\n");

/** `$1` = path, `$2` = max bytes. stdout: the bytes; stderr: `size <n>` first. */
export const READ_SCRIPT = [
  "set -eu",
  ...RESOLVE,
  'if [ ! -e "$r" ]; then echo "no such file" >&2; exit 4; fi',
  'if [ ! -f "$r" ]; then echo "not a regular file" >&2; exit 5; fi',
  'echo "size $(stat -c %s -- "$r")" >&2',
  'exec head -c "$2" -- "$r"',
].join("\n");

/** `$1` = path; the content arrives on stdin. Prints `::ws::{"created":true|false}`. */
export const WRITE_SCRIPT = [
  "set -eu",
  ...RESOLVE,
  'if [ -d "$r" ]; then echo "path is a directory" >&2; exit 5; fi',
  'created=true; if [ -e "$r" ]; then created=false; fi',
  'mkdir -p -- "$(dirname -- "$r")"',
  // Re-resolve after mkdir: a parent created as a symlink earlier must still land inside.
  'case "$(realpath -m -- "$(dirname -- "$r")")" in /workspace|/workspace/*) ;; *) echo "path resolves outside the workspace" >&2; exit 3;; esac',
  'cat > "$r"',
  `printf '%s{"created":%s}\\n' '${WS_MARKER}' "$created"`,
].join("\n");

/**
 * `$1` = the one path the patch may touch; the patch arrives on stdin. `git apply` refuses paths
 * outside the repository; `--include` limits it to `$1` and the file list check makes a patch
 * that touches anything else fail instead of half-applying.
 */
export const PATCH_SCRIPT = [
  "set -eu",
  ...RESOLVE,
  "cd /workspace",
  "patch=/tmp/gittifacts-ws.patch",
  'cat > "$patch"',
  // `git diff` style (a/ b/ prefixes) strips one level; a plain `--- src/x.ts` patch strips none.
  "p=1",
  "if ! grep -qE '^(---|[+][+][+]) (a/|b/|/dev/null)' \"$patch\"; then p=0; fi",
  'git apply -p"$p" --check --whitespace=nowarn -- "$patch"',
  'files="$(git apply -p"$p" --numstat -- "$patch" | cut -f3- | sort -u)"',
  'if [ -z "$files" ]; then echo "the patch changes nothing" >&2; exit 6; fi',
  'if [ "$files" != "$1" ]; then echo "the patch changes other files than $1: $(echo "$files" | tr "\\n" " ")" >&2; exit 6; fi',
  'git apply -p"$p" --whitespace=nowarn -- "$patch"',
  'rm -f "$patch"',
  `printf '%s{"applied":true}\\n' '${WS_MARKER}'`,
].join("\n");

/**
 * Stats of everything in the workspace (committed or not, untracked included, .gitignore
 * respected) against `$WS_BASE`, through a throwaway index so the real one is untouched.
 * stdout: `git diff --numstat -z` then a NUL-separated `--name-status`, split by a marker line.
 */
export const DIFF_STAT_SCRIPT = [
  "set -eu",
  "cd /workspace",
  "export GIT_INDEX_FILE=/tmp/gittifacts-ws-index",
  'rm -f "$GIT_INDEX_FILE"',
  "git read-tree HEAD",
  "git -c core.hooksPath=/dev/null add -A",
  'git diff --cached -M --numstat -z "$WS_BASE"',
  `printf '\\n${WS_MARKER}name-status\\n'`,
  'git diff --cached -M --name-status -z "$WS_BASE"',
].join("\n");

/** The unified diff for DIFF_STAT_SCRIPT's index (run right after it). */
export const DIFF_PATCH_SCRIPT = [
  "set -eu",
  "cd /workspace",
  "export GIT_INDEX_FILE=/tmp/gittifacts-ws-index",
  'git diff --cached -M --no-color --no-ext-diff "$WS_BASE"',
].join("\n");

/**
 * Commit everything as `$GIT_AUTHOR_*` and push HEAD to `refs/heads/$WS_BRANCH` of the fork.
 *
 * Before it runs anything with the token, it rewrites .git/config from scratch: repo code or an
 * agent could have added url rewrites (`insteadOf`), credential helpers, an fsmonitor command or
 * filters that would see or redirect the token. Hooks are off (`core.hooksPath=/dev/null`,
 * `--no-verify`). The token is in this exec's env only (`GIT_CONFIG_*`). A non-fast-forward
 * (the fork moved) is reported, never forced.
 */
export const COMMIT_PUSH_SCRIPT = [
  "set -eu",
  "cd /workspace",
  "cat > .git/config <<EOF",
  "[core]",
  "\trepositoryformatversion = 1",
  "\tfilemode = true",
  "\tbare = false",
  "\tlogallrefupdates = true",
  "[extensions]",
  "\tpartialclone = origin",
  '[remote "origin"]',
  "\turl = $WS_REMOTE",
  "\tfetch = +refs/heads/*:refs/remotes/origin/*",
  "\tpromisor = true",
  "\tpartialclonefilter = blob:none",
  "EOF",
  'before="$(git rev-parse -q --verify HEAD || true)"',
  "git -c core.hooksPath=/dev/null add -A",
  "committed=false",
  "if ! git diff --cached --quiet; then",
  '  git -c core.hooksPath=/dev/null -c commit.gpgSign=false commit -q --no-verify -m "$WS_MESSAGE"',
  "  committed=true",
  "fi",
  'head="$(git rev-parse HEAD)"',
  'files="$(git diff --name-only "$WS_PUSHED" "$head" 2>/dev/null | wc -l | tr -d " ")"',
  'if [ "$head" = "$WS_PUSHED" ]; then',
  `  printf '%s{"status":"nothing","head":"%s"}\\n' '${WS_MARKER}' "$head"`,
  "  exit 0",
  "fi",
  'if out="$(git -c core.hooksPath=/dev/null push -q --no-verify --porcelain origin "HEAD:refs/heads/$WS_BRANCH" 2>&1)"; then',
  `  printf '%s{"status":"pushed","head":"%s","before":"%s","committed":%s,"files":%s}\\n' '${WS_MARKER}' "$head" "$before" "$committed" "\${files:-0}"`,
  "else",
  `  printf '%s{"status":"rejected","head":"%s"}\\n' '${WS_MARKER}' "$head"`,
  '  echo "$out" | tail -n 20 >&2',
  "fi",
].join("\n");

/** Marker JSON from a script's stdout (the last `::ws::` line), or null. */
export function lastWsMarker(stdout: string): unknown {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (!line.startsWith(WS_MARKER)) continue;
    try {
      return JSON.parse(line.slice(WS_MARKER.length)) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

export type DiffStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";

const STATUS: Record<string, DiffStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

/** Parses DIFF_STAT_SCRIPT's stdout into per-file stats. */
export function parseDiffStats(
  stdout: string,
): Array<{ path: string; status: DiffStatus; additions: number; deletions: number }> {
  const split = stdout.indexOf(`\n${WS_MARKER}name-status\n`);
  const numstat = split === -1 ? stdout : stdout.slice(0, split);
  const nameStatus = split === -1 ? "" : stdout.slice(split + `\n${WS_MARKER}name-status\n`.length);
  // numstat -z: "add\tdel\tpath\0" or, for renames/copies, "add\tdel\t\0old\0new\0".
  const counts = new Map<string, { additions: number; deletions: number }>();
  const n = numstat.split("\0");
  for (let i = 0; i < n.length; i++) {
    const rec = n[i] ?? "";
    if (rec.trim() === "") continue;
    const [add = "0", del = "0", path = ""] = rec.split("\t");
    let target = path;
    if (path === "") {
      i += 2;
      target = n[i] ?? "";
    }
    counts.set(target, {
      additions: add === "-" ? 0 : Number(add) || 0,
      deletions: del === "-" ? 0 : Number(del) || 0,
    });
  }
  const out: Array<{ path: string; status: DiffStatus; additions: number; deletions: number }> = [];
  const s = nameStatus.split("\0");
  for (let i = 0; i < s.length; i++) {
    const code = s[i] ?? "";
    if (code === "") continue;
    const letter = code[0] ?? "M";
    const renamed = letter === "R" || letter === "C";
    i += renamed ? 2 : 1;
    const path = s[i] ?? "";
    out.push({
      path,
      status: STATUS[letter] ?? "modified",
      ...(counts.get(path) ?? { additions: 0, deletions: 0 }),
    });
  }
  return out;
}
