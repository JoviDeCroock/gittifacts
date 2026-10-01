/**
 * Live smoke test of @app/gitwire against a real remote (e.g. a Cloudflare Artifacts repo).
 * NOT part of `pnpm test`.
 *
 *   GITWIRE_REMOTE=https://<acct>.artifacts.cloudflare.net/git/<ns>/<repo>.git \
 *   GITWIRE_TOKEN='art_v2_…?expires=…' \
 *   pnpm --filter @app/gitwire smoke
 *
 * Optional env:
 *   GITWIRE_AUTH=basic    use Basic auth (password = token without `?expires=`) for gitwire calls
 *   GITWIRE_REMOTE_2=…    a second repo to exercise transferObjects across repos
 *   GITWIRE_TOKEN_2=…     token for GITWIRE_REMOTE_2 (Artifacts tokens are per repo; defaults to GITWIRE_TOKEN)
 *   GITWIRE_KEEP=1        keep the refs this run created (default: delete them at the end)
 *
 * It only creates refs under refs/heads/gitwire-smoke/<run>/ and refs/notes/gitwire-smoke-<run>
 * (plus refs/heads/gitwire-smoke/<run>/mq on GITWIRE_REMOTE_2) and deletes them afterwards.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fastForward,
  fetchPack,
  type GitRemote,
  listRefs,
  MissingObjectError,
  parsePack,
  type RefUpdate,
  readNote,
  receivePack,
  StaleRefError,
  transferObjects,
  writeNote,
  ZERO_SHA,
} from "../src/index.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error("Set GITWIRE_REMOTE (…/repo.git) and GITWIRE_TOKEN.");
    process.exit(2);
  }
  return value;
}
const url = requireEnv("GITWIRE_REMOTE");
const token = requireEnv("GITWIRE_TOKEN");
const auth: GitRemote["auth"] =
  process.env.GITWIRE_AUTH === "basic"
    ? { basic: { username: "x", password: token.split("?expires=")[0]! } }
    : { bearer: token };
const remote: GitRemote = { url, auth };
const url2 = process.env.GITWIRE_REMOTE_2;
const token2 = process.env.GITWIRE_TOKEN_2 ?? token;
const auth2: GitRemote["auth"] =
  process.env.GITWIRE_AUTH === "basic"
    ? { basic: { username: "x", password: token2.split("?expires=")[0]! } }
    : { bearer: token2 };
const remote2: GitRemote | undefined = url2 ? { url: url2, auth: auth2 } : undefined;

const run = `${Date.now().toString(36)}`;
const branch = `refs/heads/gitwire-smoke/${run}/branch`;
const next = `refs/heads/gitwire-smoke/${run}/next`;
const mq = `refs/heads/gitwire-smoke/${run}/mq`;
const notesRef = `refs/notes/gitwire-smoke-${run}`;
const author = { name: "gitwire smoke", email: "smoke@gittifacts.invalid" };

const dir = mkdtempSync(join(tmpdir(), "gitwire-smoke-"));
const git = (...args: string[]) =>
  execFileSync("git", ["-c", `http.extraHeader=Authorization: Bearer ${token}`, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    },
  }).trim();

let failures = 0;
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const started = Date.now();
  try {
    const result = await fn();
    console.log(`ok    ${name} (${Date.now() - started} ms)`);
    return result;
  } catch (err) {
    failures++;
    console.log(
      `FAIL  ${name}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
    return undefined;
  }
}
function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  console.log(`gitwire live smoke, run ${run}\nremote ${url}${url2 ? `\nremote2 ${url2}` : ""}\n`);

  // 1. Seed two commits with the git CLI (A, and its child B).
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "smoke.txt"), `gitwire smoke ${run}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", `smoke ${run} A`);
  const a = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "smoke.txt"), `gitwire smoke ${run}\nsecond line\n`);
  git("commit", "-q", "-am", `smoke ${run} B`);
  const b = git("rev-parse", "HEAD");
  await step("git CLI push of A and B", async () => {
    git("push", "-q", url, `${a}:${branch}`, `${b}:${next}`);
  });

  // 2. Discovery.
  await step("listRefs v2 (ls-refs)", async () => {
    const refs = await listRefs(remote, { prefixes: [`refs/heads/gitwire-smoke/${run}/`] });
    console.log(`      protocol ${refs.protocol}; caps: ${[...refs.capabilities].join(", ")}`);
    check(
      refs.get(branch) === a && refs.get(next) === b,
      `unexpected refs ${JSON.stringify([...refs])}`,
    );
  });
  await step("listRefs v1", async () => {
    const refs = await listRefs(remote, { protocol: 1 });
    check(refs.get(branch) === a, "branch missing from v1 advertisement");
  });
  await step("receive-pack advertisement", async () => {
    const refs = await listRefs(remote, { service: "git-receive-pack" });
    console.log(`      caps: ${[...refs.capabilities].join(" ")}`);
    check(refs.get(next) === b, "next missing from receive-pack advertisement");
  });

  // 3. Notes: write, append, read back with gitwire and with the git CLI.
  await step("writeNote (replace) + readNote", async () => {
    const content = `${JSON.stringify({ run, kind: "smoke" })}\n`;
    const res = await writeNote(remote, { notesRef, targetSha: a, content, author });
    console.log(`      notes commit ${res.notesCommit} after ${res.attempts} attempt(s)`);
    check((await readNote(remote, notesRef, a)) === content, "readNote mismatch");
  });
  await step("writeNote (append) + git notes show", async () => {
    await writeNote(remote, {
      notesRef,
      targetSha: a,
      content: "appended\n",
      author,
      mode: "append",
    });
    const expected = `${JSON.stringify({ run, kind: "smoke" })}\n\nappended\n`;
    check((await readNote(remote, notesRef, a)) === expected, "readNote after append mismatch");
    git("fetch", "-q", url, `${notesRef}:${notesRef}`);
    const viaGit = execFileSync("git", ["notes", `--ref=${notesRef}`, "show", a], {
      cwd: dir,
      encoding: "utf8",
    });
    check(viaGit === expected, `git notes show returned ${JSON.stringify(viaGit)}`);
  });

  // 4. Compare-and-swap fast-forward.
  await step("fastForward A -> B", async () => {
    await fastForward(remote, branch, a, b);
    check(
      (await listRefs(remote, { prefixes: [branch] })).get(branch) === b,
      "branch did not move",
    );
  });
  await step("fastForward with stale old SHA -> StaleRefError", async () => {
    const err = await fastForward(remote, branch, a, b).catch((e: unknown) => e);
    check(err instanceof StaleRefError, `expected StaleRefError, got ${String(err)}`);
    console.log(`      ${(err as Error).message}`);
  });
  await step("fastForward to an absent commit -> MissingObjectError", async () => {
    const err = await fastForward(
      remote,
      branch,
      b,
      "1234567890123456789012345678901234567890",
    ).catch((e: unknown) => e);
    check(err instanceof MissingObjectError, `expected MissingObjectError, got ${String(err)}`);
    console.log(`      ${(err as Error).message}`);
  });

  // 5. Fetch.
  await step("fetchPack (full) + parsePack", async () => {
    const objects = await parsePack(await fetchPack(remote, { wants: [b], haves: [] }));
    check(
      objects.some((o) => o.sha === b) && objects.some((o) => o.sha === a),
      "commits missing from pack",
    );
    console.log(`      ${objects.length} objects`);
  });
  await step("fetchPack depth 1 + blob:none", async () => {
    const objects = await parsePack(
      await fetchPack(remote, { wants: [b], depth: 1, filter: "blob:none" }),
    );
    check(!objects.some((o) => o.type === "blob"), "blob:none returned blobs");
    check(
      objects.filter((o) => o.type === "commit").length === 1,
      "depth 1 returned more than one commit",
    );
  });

  // 6. Cross-repo transfer (optional).
  if (remote2) {
    await step("transferObjects remote -> remote2", async () => {
      await transferObjects(remote, remote2, { sha: b, toRef: mq });
      check(
        (await listRefs(remote2, { prefixes: [mq] })).get(mq) === b,
        "mq ref not created on remote2",
      );
    });
  }

  // 7. Cleanup (delete-only receive-pack: no pack is sent).
  if (process.env.GITWIRE_KEEP !== "1") {
    await step("delete created refs", async () => {
      const refs = await listRefs(remote, {
        prefixes: [`refs/heads/gitwire-smoke/${run}/`, notesRef],
      });
      const updates: RefUpdate[] = [...refs].map(([ref, sha]) => ({
        ref,
        oldSha: sha,
        newSha: ZERO_SHA,
      }));
      if (updates.length) {
        const report = await receivePack(remote, updates);
        check(
          report.refs.every((r) => r.ok),
          `delete failed: ${JSON.stringify(report.refs)}`,
        );
      }
      if (remote2) {
        const mqSha = (await listRefs(remote2, { prefixes: [mq] })).get(mq);
        if (mqSha) await fastForward(remote2, mq, mqSha, ZERO_SHA);
      }
    });
  }
}

main()
  .catch((err: unknown) => {
    failures++;
    console.error(err);
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} step(s) failed` : "\nall steps passed");
    process.exitCode = failures ? 1 : 0;
  });
