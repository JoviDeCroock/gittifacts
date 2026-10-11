/**
 * /signin (and `?mode=signup`): email and password, in the product's own frame. When `next` is a
 * claim link, a consent request, a CLI login or an install, the heading says what you're signing
 * in to do. Agents get their own way in under the form: the /start URL, as on the landing.
 */
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api } from "../api/client.js";
import { isMockMode } from "../api/mode.js";
import { signInOptions } from "../api/password.js";
import { GITHUB_SURFACES } from "@app/domain/surfaces";
import { LANE_LABELS } from "@app/domain/vocabulary";
import { CopyLine } from "../components/CopyLine.js";
import { GitHubMark, Icon } from "../components/Icon.js";
import { BrandMark } from "../components/Shell.js";
import { Button, LaneTag } from "../components/ui.js";
import { signinCopy, signinPurpose } from "../lib/signin-context.js";
import { session, signInWithEmail, signInWithGitHub, signUpWithEmail } from "../state/session.js";
import "../styles/signin.css";

type Field = "name" | "email" | "password";
type Mode = "signin" | "signup";

/** Checks that need no round-trip; the server still has the last word. */
function localProblems(mode: Mode, name: string, email: string, password: string) {
  const out: Partial<Record<Field, string>> = {};
  if (mode === "signup" && name.trim() === "") out.name = "Enter your name.";
  if (email.trim() === "") out.email = "Enter your email address.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) out.email = "Enter an email address like maya@acme.dev.";
  if (password === "") out.password = "Enter your password.";
  else if (mode === "signup" && password.length < 8) out.password = "Use at least 8 characters.";
  return out;
}

export function SignIn() {
  const { query } = useLocation();
  // `/signin?mode=signup` (the landing page's "Create an account") opens on the sign-up form.
  const mode = useSignal<Mode>(query.mode === "signup" ? "signup" : "signin");
  const busy = useSignal<"github" | "email" | null>(null);
  const error = useSignal<string | null>(null);
  const problems = useSignal<Partial<Record<Field, string>>>({});
  const name = useSignal("");
  const email = useSignal(isMockMode() ? "maya@acme.dev" : "");
  const password = useSignal(isMockMode() ? "demo-password" : "");
  const repo = useSignal<string | undefined>(undefined);
  const form = useRef<HTMLFormElement>(null);
  const purpose = signinPurpose(query.next);
  const claimToken = purpose.kind === "claim" ? purpose.token : null;
  const copy = signinCopy(purpose, mode.value, repo.value);
  // "Forgot password?" only where the server can e-mail a reset link (api/password.ts).
  const canReset = useSignal(false);
  useEffect(() => {
    void signInOptions().then((o) => (canReset.value = o.passwordReset));
  }, []);

  useEffect(() => {
    document.title = `${mode.value === "signin" ? "Sign in" : "Create an account"} · gittifacts`;
  }, [mode.value]);

  // A claim link is readable signed out: name the repo the person came to claim.
  useEffect(() => {
    if (!claimToken) return;
    let live = true;
    api
      .claim(claimToken)
      .then((v) => {
        if (live) repo.value = v.project.name;
      })
      .catch(() => {
        /* "this repo" is fine; the claim page says what's wrong with the link */
      });
    return () => {
      live = false;
    };
  }, [claimToken]);

  function switchMode() {
    mode.value = mode.value === "signin" ? "signup" : "signin";
    error.value = null;
    problems.value = {};
    // The URL keeps the mode, so a reload lands on the same form (and `next` survives).
    const params = new URLSearchParams(window.location.search);
    if (mode.value === "signup") params.set("mode", "signup");
    else params.delete("mode");
    const q = params.toString();
    history.replaceState(history.state, "", `${window.location.pathname}${q ? `?${q}` : ""}`);
  }

  const s = session.value;
  const notice =
    s.status === "anon" && s.reason === "expired"
      ? "Your session ended. Sign in again to pick up where you left off."
      : s.status === "error"
        ? `The server could not check your session: ${s.message}`
        : null;

  async function submit(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    error.value = null;
    const local = localProblems(mode.value, name.value, email.value, password.value);
    problems.value = local;
    const first = (["name", "email", "password"] as const).find((f) => local[f]);
    if (first) {
      form.current?.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus();
      return;
    }
    busy.value = "email";
    const res =
      mode.value === "signin"
        ? await signInWithEmail(email.value.trim(), password.value)
        : await signUpWithEmail(name.value.trim(), email.value.trim(), password.value);
    busy.value = null;
    if (!res.ok) error.value = res.message ?? "Sign-in failed.";
  }

  async function github() {
    if (busy.value) return;
    error.value = null;
    busy.value = "github";
    const res = await signInWithGitHub();
    busy.value = null;
    if (!res.ok) error.value = res.message ?? "GitHub sign-in did not start.";
  }

  function fieldProps(f: Field) {
    const problem = problems.value[f];
    return {
      "aria-invalid": problem || (error.value && f !== "name") ? ("true" as const) : undefined,
      "aria-describedby": problem ? `signin-${f}-error` : error.value ? "signin-error" : undefined,
    };
  }

  return (
    <div class="signin">
      <main class="signin__main" id="main">
        {/* The marketing page: a full load (the Worker serves `/`), not an SPA route. */}
        <a class="signin__brand" href="/" target="_top">
          <BrandMark size={26} />
          <span class="brand__word">gittifacts</span>
        </a>
        <h1 class="signin__title" data-testid="signin-title">
          {copy.title}
        </h1>
        <p class="signin__lede">{copy.lede}</p>

        {notice ? (
          <p class="signin__notice" role="status">
            <Icon name="info" size={16} />
            {notice}
          </p>
        ) : null}

        {/* GitHub surfaces off (@app/domain/surfaces): email only. */}
        {GITHUB_SURFACES ? (
          <>
            <Button
              variant="secondary"
              wide
              class="signin__github"
              busy={busy.value === "github"}
              busyLabel="Opening GitHub…"
              onClick={github}
            >
              <GitHubMark />
              Continue with GitHub
            </Button>

            <div class="signin__or" role="separator">
              <span>or with email</span>
            </div>
          </>
        ) : null}

        <form class="signin__form" ref={form} onSubmit={submit} noValidate>
          {mode.value === "signup" ? (
            <label class="field">
              <span class="field__label">Name</span>
              <input
                class="input"
                name="name"
                autoComplete="name"
                required
                value={name.value}
                onInput={(e) => (name.value = e.currentTarget.value)}
                {...fieldProps("name")}
              />
              <FieldProblem id="signin-name-error" text={problems.value.name} />
            </label>
          ) : null}
          <label class="field">
            <span class="field__label">Email</span>
            <input
              class="input"
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email.value}
              onInput={(e) => (email.value = e.currentTarget.value)}
              {...fieldProps("email")}
            />
            <FieldProblem id="signin-email-error" text={problems.value.email} />
          </label>
          <label class="field">
            <span class="field__label">Password</span>
            <input
              class="input"
              type="password"
              name="password"
              autoComplete={mode.value === "signin" ? "current-password" : "new-password"}
              required
              minLength={8}
              value={password.value}
              onInput={(e) => (password.value = e.currentTarget.value)}
              {...fieldProps("password")}
            />
            {problems.value.password ? (
              <FieldProblem id="signin-password-error" text={problems.value.password} />
            ) : mode.value === "signup" ? (
              <span class="field__hint">At least 8 characters.</span>
            ) : null}
          </label>
          {mode.value === "signin" && canReset.value ? (
            <p class="field__hint">
              <a href="/forgot-password">Forgot password?</a>
            </p>
          ) : null}
          {error.value ? (
            <p class="field__error" id="signin-error" role="alert">
              {error.value}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            wide
            busy={busy.value === "email"}
            busyLabel={mode.value === "signin" ? "Signing in…" : "Creating account…"}
          >
            {mode.value === "signin" ? "Sign in" : "Create account"}
          </Button>
        </form>

        <p class="signin__switch">
          {mode.value === "signin" ? "New to gittifacts?" : "Already have an account?"}{" "}
          <button type="button" class="linklike" onClick={switchMode}>
            {mode.value === "signin" ? "Create an account" : "Sign in instead"}
          </button>
        </p>

        {/* Agents don't need this form: the same way in as the landing's. */}
        <div class="signin__agent" data-testid="signin-agent">
          <p>
            <Icon name="bot" size={16} /> Setting up an agent? It can start without an account;
            point it at:
          </p>
          <CopyLine text={`${window.location.origin}/start`} label="Copy the start URL" />
        </div>

        {isMockMode() ? (
          <p class="demo-note">
            <Icon name="info" size={14} />
            Demo mode: any email signs you in as Maya Okafor. All data is synthetic.
          </p>
        ) : null}
      </main>

      <aside class="signin__how" aria-labelledby="how-title" data-testid="how-it-works">
        <div class="signin__how-inner">
          <h2 id="how-title" class="signin__how-title">
            How it works
          </h2>
          <ol class="how">
            <li class="how__step">
              <span class="how__n tnum" aria-hidden="true">
                1
              </span>
              <div>
                <p class="how__lead">Your agent drafts a Plan. You approve it.</p>
                <p class="how__body">A Plan says what should change and how to tell it worked. Nothing starts until a person approves it.</p>
              </div>
            </li>
            <li class="how__step">
              <span class="how__n tnum" aria-hidden="true">
                2
              </span>
              <div>
                <p class="how__lead">It builds a Change, with proof.</p>
                <p class="how__body">A Change is like a pull request that carries its evidence: tests, red/green proof and coverage, run and signed by the platform.</p>
              </div>
            </li>
            <li class="how__step">
              <span class="how__n tnum" aria-hidden="true">
                3
              </span>
              <div>
                <p class="how__lead">You review only what needs you.</p>
                <p class="how__body">Each Change gets a review lane from what it proves:</p>
                <ul class="how__lanes">
                  {([2, 1, 0] as const).map((l) => (
                    <li key={l}>
                      <LaneTag lane={l} size="sm" />
                      <span>
                        <b>{LANE_LABELS[l].name}</b> {LANE_LABELS[l].description}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          </ol>
        </div>
      </aside>
    </div>
  );
}

function FieldProblem({ id, text }: { id: string; text: string | undefined }) {
  return text ? (
    <span class="field__error" id={id}>
      {text}
    </span>
  ) : null;
}
