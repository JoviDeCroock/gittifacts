import { useEffect } from "preact/hooks";
import { ErrorBoundary, LocationProvider, Route, Router, lazy, useLocation } from "preact-iso";
import { Shell } from "./components/Shell.js";
import { Loading } from "./components/ui.js";
import { loadSession, session } from "./state/session.js";

const SignIn = lazy(() => import("./routes/signin.js").then((m) => m.SignIn));
const Repos = lazy(() => import("./routes/repos.js").then((m) => m.Repos));
const RepoChanges = lazy(() => import("./routes/repo.js").then((m) => m.RepoChanges));
const PlanView = lazy(() => import("./routes/plan.js").then((m) => m.PlanView));
const TourView = lazy(() => import("./routes/tour.js").then((m) => m.TourView));
const EvidenceView = lazy(() => import("./routes/evidence.js").then((m) => m.EvidenceView));
const RolloutView = lazy(() => import("./routes/rollout.js").then((m) => m.RolloutView));
const AuditView = lazy(() => import("./routes/audit.js").then((m) => m.AuditView));
const AgentsView = lazy(() => import("./routes/agents.js").then((m) => m.AgentsView));
const NotFound = lazy(() => import("./routes/notfound.js").then((m) => m.NotFound));
const OAuthConsent = lazy(() => import("./routes/oauth-consent.js").then((m) => m.OAuthConsent));
const DeviceView = lazy(() => import("./routes/device.js").then((m) => m.DeviceView));

/** Agent consent screens: one decision, no navigation to wander off to. */
const FOCUSED = /^\/(oauth\/consent|device)\/?$/;

function AuthedApp() {
  const { path } = useLocation();
  if (FOCUSED.test(path)) {
    return (
      <ErrorBoundary>
        <Router>
          <Route path="/oauth/consent" component={OAuthConsent} />
          <Route path="/device" component={DeviceView} />
        </Router>
      </ErrorBoundary>
    );
  }
  return (
    <Shell>
      <ErrorBoundary>
        <Router>
          <Route path="/" component={Repos} />
          <Route path="/repos/:repoId" component={RepoChanges} />
          <Route path="/plans/:planId" component={PlanView} />
          <Route path="/changes/:changeId" component={TourView} />
          <Route path="/changes/:changeId/evidence" component={EvidenceView} />
          <Route path="/changes/:changeId/rollout" component={RolloutView} />
          <Route path="/audit" component={AuditView} />
          <Route path="/agents" component={AgentsView} />
          <Route path="/signin" component={RedirectHome} />
          <Route default component={NotFound} />
        </Router>
      </ErrorBoundary>
    </Shell>
  );
}

function RedirectHome() {
  const { route, query } = useLocation();
  useEffect(() => {
    const next = query.next && query.next.startsWith("/") && !query.next.startsWith("//") ? query.next : "/";
    route(next, true);
  }, [route, query.next]);
  return null;
}

function Gate() {
  const s = session.value;
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
      <SignIn />
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
