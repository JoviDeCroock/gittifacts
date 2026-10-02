/**
 * The gittifacts CLI as the platform serves it: an `npm pack` tarball in the Worker's static
 * assets (`/cli/gittifacts.tgz`), because the package is not on npm yet. `npx -y <tarball>` runs
 * it without installing anything. The tarball has no host baked in, so commands pass `--host`
 * (the CLI remembers it after `login` or `init`).
 */

export const CLI_TARBALL_PATH = "/cli/gittifacts.tgz";

/** `https://h` (or a `{{host}}` placeholder) → `https://h/cli/gittifacts.tgz`. */
export function cliTarballUrl(host: string): string {
  return `${host.trim().replace(/\/+$/, "")}${CLI_TARBALL_PATH}`;
}

/** `npx -y https://h/cli/gittifacts.tgz --host https://h <args>`: runnable as is. */
export function cliCommand(host: string, args = ""): string {
  const origin = host.trim().replace(/\/+$/, "");
  const rest = args.trim();
  return `npx -y ${cliTarballUrl(origin)} --host ${origin}${rest === "" ? "" : ` ${rest}`}`;
}

/**
 * Puts `gittifacts` on PATH for the shell, so the `gittifacts …` commands the CLI prints in
 * `nextSteps` and `fix.command` run as they are.
 */
export function cliAlias(host: string): string {
  return `alias gittifacts="npx -y ${cliTarballUrl(host)}"`;
}

/** Said wherever the tarball command appears. */
export const CLI_NPM_NOTE =
  "The CLI is not on npm yet, so it is served by the platform; `npx gittifacts` will work once it is published.";
