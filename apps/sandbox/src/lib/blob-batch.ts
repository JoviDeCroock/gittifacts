/**
 * Read many blobs in one `git cat-file --batch` process (binary-safe: sizes are in bytes, so the
 * output is parsed as a Buffer). Credentials are scrubbed and lazy fetches are off: a blob that
 * is not in the checkout comes back as null, never as a network round trip.
 */
import { spawn } from "node:child_process";
import { scrubbedEnv } from "./proc.js";

/** Text of each blob (null when missing or binary), by object id. */
export function readBlobs(
  repo: string,
  oids: readonly string[],
  timeoutMs = 5 * 60_000,
): Promise<Map<string, string | null>> {
  const unique = [...new Set(oids)];
  const out = new Map<string, string | null>();
  if (unique.length === 0) return Promise.resolve(out);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "safe.directory=*", "-C", repo, "cat-file", "--batch"], {
      cwd: repo,
      env: scrubbedEnv({ GIT_NO_LAZY_FETCH: "1", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`git cat-file --batch failed (${code}): ${stderr.trim().slice(0, 500)}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      let pos = 0;
      for (const oid of unique) {
        const nl = buf.indexOf(10, pos);
        if (nl === -1) break;
        const header = buf.subarray(pos, nl).toString("utf8").split(" ");
        if (header[1] === "missing" || header.length < 3) {
          out.set(oid, null);
          pos = nl + 1;
          continue;
        }
        const size = Number(header[2]);
        const body = buf.subarray(nl + 1, nl + 1 + size);
        // Binary content (a NUL in the first 8 KiB, git's own heuristic) is not text.
        out.set(oid, body.subarray(0, 8192).includes(0) ? null : body.toString("utf8"));
        pos = nl + 1 + size + 1;
      }
      for (const oid of unique) if (!out.has(oid)) out.set(oid, null);
      resolve(out);
    });
    child.stdin.end(`${unique.join("\n")}\n`);
  });
}
