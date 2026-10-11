/**
 * The CLI command for this host. The CLI is not on npm yet: the platform serves it as an npm
 * tarball at /cli/v2/gittifacts.tgz (@app/conventions `cliCommand` writes the same for /start).
 */
export function cliCommand(args: string, origin: string = window.location.origin): string {
  return `npx -y ${origin}/cli/v2/gittifacts.tgz --host ${origin} ${args}`;
}
