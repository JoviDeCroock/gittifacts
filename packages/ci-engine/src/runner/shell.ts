/** POSIX shell helpers for building container exec argv. Pure. */

/** Single-quotes `value` for `sh`. Safe for any string without NUL. */
export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("cannot shell-quote a string containing NUL");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Grace period between SIGTERM and SIGKILL when a command times out. */
export const KILL_AFTER_SECONDS = 10;

/**
 * argv for running a user command with a hard timeout:
 * `sh -c "exec timeout --kill-after=10 <secs> sh -c '<cmd>'"`.
 * Exit 124 means the timeout fired (SIGTERM was enough); 137 means it had to SIGKILL.
 */
export function timedCommandArgv(command: string, timeoutSeconds: number): string[] {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`timeout must be a positive integer number of seconds, got ${timeoutSeconds}`);
  }
  return [
    "sh",
    "-c",
    `exec timeout --kill-after=${KILL_AFTER_SECONDS} ${timeoutSeconds} sh -c ${shellQuote(command)}`,
  ];
}

export function isTimeoutExit(exitCode: number): boolean {
  return exitCode === 124 || exitCode === 137;
}

export const WORKSPACE = "/workspace";
export const EVIDENCE_OUT = "/tmp/gittifacts/evidence.json";

/** `/workspace/<cwd>` for a validated relative cwd. */
export function workspacePath(cwd: string | undefined): string {
  return cwd === undefined || cwd === "" ? WORKSPACE : `${WORKSPACE}/${cwd}`;
}

/**
 * Brings `/workspace` to `$GITTIFACTS_HEAD_SHA`. Auth comes from the exec env only
 * (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0=http.extraHeader`), so the token never reaches argv, the
 * snapshot, or a later step, and also applies to the lazy blob fetches `--filter=blob:none` causes
 * during checkout.
 *
 * - Fresh container: `git init` + blobless shallow fetch + checkout.
 * - From a snapshot taken at the same commit: nothing to do (the parent step's changes are kept).
 * - From a snapshot taken at another commit (a cache hit): fetch and force-checkout the new commit
 *   over it, keeping untracked/ignored files such as `node_modules`.
 * - With `$GITTIFACTS_BASE_SHA` set: also fetch the base commit *with* blobs (`--no-filter`),
 *   because later commands run without credentials and could not fetch them lazily.
 *
 * Verified against git 2.39 with a local `uploadpack.allowFilter` remote: fresh, same-commit and
 * moved-commit cases, and that no base blob is left missing.
 */
export const CHECKOUT_SCRIPT = [
  "set -eu",
  `mkdir -p ${WORKSPACE}`,
  `cd ${WORKSPACE}`,
  'if [ ! -d .git ]; then git init -q . && git remote add origin "$GITTIFACTS_REMOTE"; else git remote set-url origin "$GITTIFACTS_REMOTE"; fi',
  'current="$(git rev-parse -q --verify HEAD^{commit} 2>/dev/null || true)"',
  'if [ "$current" != "$GITTIFACTS_HEAD_SHA" ]; then',
  '  git fetch -q --no-tags --depth=1 --filter=blob:none origin "$GITTIFACTS_HEAD_SHA"',
  '  git -c advice.detachedHead=false checkout -q --force --detach "$GITTIFACTS_HEAD_SHA"',
  "fi",
  // No existence check first: in a partial clone `git cat-file -e` would lazily fetch the commit
  // without blobs. `--no-filter` overrides the remote's recorded `partialclonefilter`.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template.
  'if [ -n "${GITTIFACTS_BASE_SHA:-}" ]; then',
  '  git fetch -q --no-tags --no-filter --depth=1 origin "$GITTIFACTS_BASE_SHA"',
  "fi",
  'echo "checked out $(git rev-parse HEAD)"',
].join("\n");

/** Env for the checkout exec. The token is only ever placed here. */
export function checkoutEnv(opts: {
  remote: string;
  headSha: string;
  baseSha?: string | undefined;
  token: string;
}): Record<string, string> {
  // PATH is inherited from the image; exec does not inherit any other image env.
  return {
    HOME: "/root",
    GIT_TERMINAL_PROMPT: "0",
    GITTIFACTS_REMOTE: opts.remote,
    GITTIFACTS_HEAD_SHA: opts.headSha,
    ...(opts.baseSha === undefined ? {} : { GITTIFACTS_BASE_SHA: opts.baseSha }),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${opts.token}`,
  };
}

/**
 * Makes the container trust the Containers interception CA (needed once HTTPS is intercepted).
 * Exit 3 when the runtime did not provide the certificate.
 */
export function trustCaScript(caPath: string): string {
  const f = shellQuote(caPath);
  return [
    `if [ ! -f ${f} ]; then echo "interception CA certificate ${caPath} is missing" >&2; exit 3; fi`,
    "mkdir -p /usr/local/share/ca-certificates",
    `cp ${f} /usr/local/share/ca-certificates/cloudflare-containers-ca.crt`,
    `if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates >/dev/null 2>&1; else cat ${f} >> /etc/ssl/certs/ca-certificates.crt; fi`,
  ].join("\n");
}

/**
 * Reduces `/workspace` to the NUL-separated repository paths read from stdin (a global-scope
 * step's cache inputs). Needs GNU tar (`--null -T -`).
 */
export const HERMETIC_SCRIPT = [
  "set -eu",
  "rm -rf /tmp/gittifacts-src",
  `mv ${WORKSPACE} /tmp/gittifacts-src`,
  `mkdir -p ${WORKSPACE}`,
  `tar -C /tmp/gittifacts-src --null -T - -cf - | tar -C ${WORKSPACE} -xf -`,
  "rm -rf /tmp/gittifacts-src",
  `echo "workspace reduced to $(find ${WORKSPACE} -type f | wc -l) cache input files"`,
].join("\n");

/**
 * Runs `command` in `cwd` (relative to the workspace). A missing directory is the step's failure
 * (exit 2 with a message), not an infrastructure error.
 */
export function inDirectory(command: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === "") return command;
  const message = shellQuote(`gittifacts: working directory ${cwd} does not exist`);
  return `cd -- ${shellQuote(cwd)} || { echo ${message} >&2; exit 2; }\n${command}`;
}
