/**
 * A screen that throws while rendering shows what failed and a way out (reload, or the
 * dashboard) inside the app frame, instead of a blank page. The first read is a sentence and the
 * way out; the exception itself waits in a disclosure, ready to copy into a report. It also keeps preact-iso's
 * ErrorBoundary job: lazy routes suspend here while their chunk loads. Resets on navigation.
 */
import { Component, type ComponentChildren } from "preact";
import { ErrorBoundary, useLocation } from "preact-iso";
import { APP_HOME } from "../lib/nav.js";
import { Icon } from "./Icon.js";
import { Page } from "./Shell.js";
import { Button, Command, EmptyState, LinkButton } from "./ui.js";

interface State {
  error: unknown;
}

class Catcher extends Component<{ path: string; children: ComponentChildren }, State> {
  override state: State = { error: null };

  override componentDidUpdate(prev: { path: string }) {
    // Navigating away from a broken screen clears the error.
    if (prev.path !== this.props.path && this.state.error !== null) this.setState({ error: null });
  }

  override componentDidCatch(error: unknown) {
    // Suspense (a lazy route loading) throws a promise; preact-iso's boundary below handles it.
    if (error instanceof Promise) throw error;
    console.error("screen failed to render", error);
    this.setState({ error });
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    const message =
      this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
    return (
      <Page title="Something went wrong">
        <EmptyState
          icon="triangle-alert"
          title="This screen failed to load"
          action={
            <>
              <Button variant="primary" icon="undo" onClick={() => window.location.reload()}>
                Reload
              </Button>
              <LinkButton href={APP_HOME} variant="secondary" icon="layers">
                Go to dashboard
              </LinkButton>
            </>
          }
        >
          <p>Something on this screen broke while it was drawing. Reloading usually fixes it.</p>
          <details class="disclosure error-details" data-testid="error-details">
            <summary>
              Technical details
              <Icon name="chevron-down" size={16} class="disclosure__chev" />
            </summary>
            <p>If it keeps happening, copy this into your report:</p>
            <Command text={message} />
          </details>
        </EmptyState>
      </Page>
    );
  }
}

export function AppErrorBoundary({ children }: { children: ComponentChildren }) {
  const { path } = useLocation();
  return (
    <Catcher path={path}>
      <ErrorBoundary>{children}</ErrorBoundary>
    </Catcher>
  );
}
