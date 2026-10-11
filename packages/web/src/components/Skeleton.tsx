/**
 * The app frame while the session is checked on first load: the sidebar (desktop) or top bar
 * (phones) with the wordmark is already drawn, and only the content area waits. So arriving is
 * one settled motion (the page fills in) instead of a blank page that becomes a whole app.
 * Static on purpose: nothing here needs the session (no repos, no name, no sign out).
 */
import { BrandMark } from "./BrandMark.js";
import { Skeleton, SkeletonHead } from "./ui.js";

export function ShellFrame({ label }: { label: string }) {
  return (
    <div class="shell" aria-busy="true" data-testid="shell-frame">
      <aside class="sidebar" aria-label="Navigation">
        <span class="brand">
          <BrandMark />
          <span class="brand__word">gittifacts</span>
        </span>
        <div class="frame__nav" aria-hidden="true">
          <span class="frame__search" />
          <Skeleton lines={5} />
        </div>
      </aside>
      <div class="shell__content">
        <div class="page">
          <header class="topbar" data-scrolled="false">
            <span class="topbar__brand">
              <BrandMark />
              <span class="brand__word topbar__word">gittifacts</span>
            </span>
          </header>
          <main id="main" class="page__main" tabIndex={-1}>
            <div class="loading" role="status" aria-live="polite">
              <span class="sr-only">{label}</span>
              <SkeletonHead />
              <Skeleton lines={4} />
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
