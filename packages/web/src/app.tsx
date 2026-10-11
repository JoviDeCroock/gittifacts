import { GITHUB_SURFACES } from "@app/domain/surfaces";
import { useCallback, useEffect, useRef } from "preact/hooks";
import { ErrorBoundary, LocationProvider, lazy, Route, Router, useLocation } from "preact-iso";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import { Shell } from "./components/Shell.js";
import { Loading } from "./components/ui.js";
import { APP_HOME, isServerPath, postAuthTarget, signInHref } from "./lib/nav.js";
import { loadSession, session } from "./state/session.js";

const SignIn = lazy(() => import("./routes/signin.js").then((m) => m.SignIn));
const Repos = lazy(() => import("./routes/repos.js").then((m) => m.Repos));
const RepoChanges = lazy(() => import("./routes/repo.js").then((m) => m.RepoChanges));
const QueueView = lazy(() => import("./routes/queue.js").then((m) => m.QueueView));
const MissionView = lazy(() => import("./routes/mission.js").then((m) => m.MissionView));
const MembersPage = lazy(() => import("./routes/members.js").then((m) => m.MembersPage));
const PlanView = lazy(() => import("./routes/plan.js").then((m) => m.PlanView));
const TourView = lazy(() => import("./routes/tour.js").then((m) => m.TourView));
const EvidenceView = lazy(() => import("./routes/evidence.js").then((m) => m.EvidenceView));
const RolloutView = lazy(() => import("./routes/rollout.js").then((m) => m.RolloutView));
const AuditView = lazy(() => import("./routes/audit.js").then((m) => m.AuditView));
const AgentsView = lazy(() => import("./routes/agents.js").then((m) => m.AgentsView));
const OnboardingView = lazy(() => import("./routes/onboarding.js").then((m) => m.OnboardingView));
const NotFound = lazy(() => import("./routes/notfound.js").then((m) => m.NotFound));
const OAuthConsent = lazy(() => import("./routes/oauth-consent.js").then((m) => m.OAuthConsent));
const DeviceView = lazy(() => import("./routes/device.js").then((m) => m.DeviceView));
const ClaimPage = lazy(() => import("./routes/claim.js").then((m) => m.ClaimPage));
const InstalledIntegrations = lazy(() => import("./routes/integrations.js").then((m) => m.InstalledIntegrations));
const IntegrationInstall = lazy(() => import("./routes/integration-install.js").then((m) => m.IntegrationInstall));
const IntegrationsDeveloper = lazy(() => import("./routes/integrations-developer.js").then((m) => m.IntegrationsDeveloper));
const IntegrationDetail = lazy(() => import("./routes/integration-detail.js").then((m) => m.IntegrationDetail));
const GithubSettings = lazy(() => import("./routes/github.js").then((m) => m.GithubSettings));
const IntegrationDeliveries = lazy(() => import("./routes/integration-deliveries.js").then((m) => m.IntegrationDeliveries));

/** GitHub surfaces off (@app/domain/surfaces): /settings/github falls through to not found. */
const GITHUB_ROUTES = GITHUB_SURFACES ? [<Route key="github" path="/settings/github" component={GithubSettings} />] : [];

/** Agent consent screens: one decision, no navigation to wander off to. */
const FOCUSED = /^\/(oauth\/consent|device|integrations\/install)\/?$/;

/** Claim links: public (an agent hands one to a person who may not be signed in yet) and focused. */
const PUBLIC = /^\/claim\/[^/]+\/?$/;

/** Where this page load started: the SPA only boots at `/` on the dev server (or a build without
 * the landing page); everywhere else the Worker serves `/` as the marketing page. */
const BOOT_PATH = typeof window === "undefined" ? "" : window.location.pathname;

/** Leaving one of these is still the first load: they only redirect (`/` in dev, `/signin` once signed in). */
const REDIRECTS = new Set(["/", "/signin"]);

const pathOf = (url: string) => new URL(url, window.location.origin).pathname.replace(/\/+$/, "") || "/";

/**
 * After an in-app navigation the new page's `<main id="main">` takes focus (without scrolling), so a
 * screen reader announces the new page and the next Tab starts inside it instead of on <body>; the
 * page starts at the top unless the URL names a fragment. preact-iso calls this once the new route
 * has rendered (after its lazy chunk), never on the first render. A page that restores a position
 * of its own (a walkthrough's stop) does so later, from its data, and wins.
 */
function useRouteFocus(): (url: string) => void {
  const shown = useRef(typeof window === "undefined" ? "" : pathOf(window.location.href));
  return useCallback((url: string) => {
    const from = shown.current;
    shown.current = pathOf(url);
    if (REDIRECTS.has(from)) return;
    if (!window.location.hash) window.scrollTo(0, 0);
    document.getElementById("main")?.focus({ preventScroll: true });
  }, []);
}

function AuthedApp() {
  const { path } = useLocation();
  const onRouteChange = useRouteFocus();
  if (FOCUSED.test(path)) {
    return (
      <ErrorBoundary>
        <Router>
          <Route path="/oauth/consent" component={OAuthConsent} />
          <Route path="/device" component={DeviceView} />
          <Route path="/integrations/install" component={IntegrationInstall} />
        </Router>
      </ErrorBoundary>
    );
  }
  return (
    <Shell>
      <AppErrorBoundary>
        <Router onRouteChange={onRouteChange}>
          <Route path="/" component={MarketingHome} />
          <Route path="/dashboard" component={Repos} />
          <Route path="/repos/:repoId" component={RepoChanges} />
          <Route path="/repos/:repoId/queue" component={QueueView} />
          <Route path="/repos/:repoId/mission" component={MissionView} />
          <Route path="/repos/:repoId/members" component={MembersPage} />
          <Route path="/plans/:planId" component={PlanView} />
          <Route path="/changes/:changeId" component={TourView} />
          <Route path="/changes/:changeId/evidence" component={EvidenceView} />
          <Route path="/changes/:changeId/rollout" component={RolloutView} />
          <Route path="/audit" component={AuditView} />
          <Route path="/agents" component={AgentsView} />
          <Route path="/settings/integrations" component={InstalledIntegrations} />
          <Route path="/settings/integrations/developer" component={IntegrationsDeveloper} />
          <Route path="/settings/integrations/developer/:integrationId" component={IntegrationDetail} />
          <Route path="/settings/integrations/developer/:integrationId/deliveries/:deliveryId?" component={IntegrationDeliveries} />
          {GITHUB_ROUTES}
          <Route path="/internal/onboarding" component={OnboardingView} />
          <Route path="/signin" component={RedirectHome} />
          <Route default component={NotFound} />
        </Router>
      </AppErrorBoundary>
    </Shell>
  );
}

/** Signed in on /signin: off to `next`, else the dashboard. */
function RedirectHome() {
  const { route, query } = useLocation();
  // Once: while the target's lazy chunk loads, this route stays mounted with the new location
  // (no `next`), and a second run sent every printed link to the dashboard (E2E caught it).
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const next = postAuthTarget(query.next);
    // Server routes (GitHub App redirects, docs, /start) need a real navigation, not the SPA router.
    if (isServerPath(next)) window.location.replace(next);
    else route(next, true);
  }, [route, query.next]);
  return null;
}

/** `/` is the marketing page the Worker serves; the SPA only shows the app there in dev. */
function MarketingHome() {
  const { route } = useLocation();
  useEffect(() => {
    if (BOOT_PATH === "/") route(APP_HOME, true);
    else window.location.assign("/");
  }, [route]);
  return null;
}

/** Signed out on an app route: sign in first, then come back here. */
function ToSignIn() {
  const { path, url, route } = useLocation();
  useEffect(() => {
    if (path !== "/signin") route(signInHref(url), true);
  }, [path, url, route]);
  return <SignIn />;
}

function Gate() {
  const { path } = useLocation();
  const s = session.value;
  if (PUBLIC.test(path)) {
    return (
      <ErrorBoundary>
        <Router>
          <Route path="/claim/:token" component={ClaimPage} />
          <Route default component={NotFound} />
        </Router>
      </ErrorBoundary>
    );
  }
  if (s.status === "loading") {
    return (
      <div class="splash">
        <Loading label="Checking your session" lines={2} />
      </div>
    );
  }
  if (s.status === "authed") return <AuthedApp />;
  return (
    <ErrorBoundary>
      <ToSignIn />
    </ErrorBoundary>
  );
}

export function App() {
  useEffect(() => {
    void loadSession();
  }, []);
  return (
    <LocationProvider>
      <Gate />
    </LocationProvider>
  );
}
