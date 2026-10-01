/**
 * Conventions version. Bump it whenever generated repo files (AGENTS.md, `.platform/*`) change in a
 * way existing repos should pick up; the platform compares the marker in a repo's AGENTS.md and
 * opens a Change that regenerates outdated copies.
 */
export const CONVENTIONS_VERSION = 1;

/** First line of every generated AGENTS.md. */
export const CONVENTIONS_MARKER = `<!-- gittifacts-conventions v${CONVENTIONS_VERSION} -->`;

const MARKER = /<!--\s*gittifacts-conventions v(\d+)\s*-->/;

/** The conventions version an AGENTS.md was generated from, or null if it has no marker. */
export function conventionsVersionOf(text: string): number | null {
  const match = MARKER.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * True when the platform should open a Change regenerating AGENTS.md: the marker is missing or
 * older than the current version. A newer marker (from a newer platform) is left alone.
 */
export function isOutdated(text: string): boolean {
  const version = conventionsVersionOf(text);
  return version === null || version < CONVENTIONS_VERSION;
}
