import { Page } from "../components/Shell.js";
import { EmptyState, LinkButton } from "../components/ui.js";

export function NotFound() {
  return (
    <Page title="Page not found">
      <EmptyState
        icon="route"
        title="Nothing lives at this address"
        action={
          <LinkButton href="/dashboard" variant="secondary" icon="layers">
            Go to dashboard
          </LinkButton>
        }
      >
        <p>The link may be from an older version of gittifacts, or the change it pointed to was removed.</p>
      </EmptyState>
    </Page>
  );
}
