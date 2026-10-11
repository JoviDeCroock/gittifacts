import { useLocation } from "preact-iso";
import { openPalette } from "../components/Palette.js";
import { Page } from "../components/Shell.js";
import { Button, EmptyState, LinkButton } from "../components/ui.js";

/** What the address asked for, as a query: an id in it (`chg_…`, 20 of [0-9a-z]), else its last segment. */
function askedFor(path: string): string {
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
  return parts.findLast((p) => /^(chg|plan|repo)_|^[0-9a-z]{20}$/.test(p)) ?? parts.at(-1) ?? "";
}

/** A dead end turned into a search: the palette opens with what the address asked for. */
export function NotFound() {
  const { path } = useLocation();
  return (
    <Page title="Page not found">
      <EmptyState
        icon="route"
        title="Nothing lives at this address"
        action={
          <>
            <Button
              variant="primary"
              icon="search"
              onClick={() => openPalette(askedFor(path))}
              data-testid="notfound-search"
            >
              Search for it
            </Button>
            <LinkButton href="/dashboard" variant="secondary" icon="layers">
              Go to dashboard
            </LinkButton>
          </>
        }
      >
        <p>
          The link may be from an older version of gittifacts, or the change it pointed to was
          removed. Search finds changes, plans, repositories and agents by name or id.
        </p>
      </EmptyState>
    </Page>
  );
}
