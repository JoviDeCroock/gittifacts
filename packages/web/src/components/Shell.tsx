/**
 * App frame. Phone: a sticky top bar with back/title/menu and a nav drawer. Desktop (≥1024px):
 * a fixed sidebar with the same destinations, and a slim acetate top bar in the content column
 * that fades in with the crumbs once the page head scrolls away. One information architecture at
 * every width: the drawer renders the sidebar's own body.
 */

import { GITHUB_SURFACES } from "@app/domain/surfaces";
import { signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api } from "../api/client.js";
import { isMockMode } from "../api/mode.js";
import type { RepoSummary } from "../api/types.js";
import { type ThemePref, themePref } from "../state/prefs.js";
import { principal, session, signOut } from "../state/session.js";
import { BrandMark } from "./BrandMark.js";
import { Icon, type IconId } from "./Icon.js";
import {
  Palette,
  PaletteButton,
  paletteOpen,
  paletteRepos,
  usePaletteShortcut,
} from "./Palette.js";
import "../styles/palette.css";
import { Who } from "./ui.js";

export { BrandMark };

/** `server`: a page the Worker serves (not an SPA route), so the router must not intercept it. */
const ALL_NAV: {
  href: string;
  label: string;
  icon: IconId;
  match: (path: string) => boolean;
  server?: boolean;
}[] = [
  { href: "/dashboard", label: "Dashboard", icon: "layers", match: (p) => p === "/dashboard" },
  { href: "/audit", label: "Audit log", icon: "scroll-text", match: (p) => p.startsWith("/audit") },
  { href: "/agents", label: "Agents", icon: "bot", match: (p) => p.startsWith("/agents") },
  {
    href: "/settings/integrations",
    label: "Integrations",
    icon: "plug",
    match: (p) => p.startsWith("/settings/integrations"),
  },
  {
    href: "/settings/github",
    label: "GitHub",
    icon: "git-branch",
    match: (p) => p.startsWith("/settings/github"),
  },
  { href: "/docs", label: "Docs", icon: "file-text", match: () => false, server: true },
];
/** The GitHub page leaves the nav while GitHub surfaces are off (@app/domain/surfaces). */
const NAV = ALL_NAV.filter((n) => GITHUB_SURFACES || n.href !== "/settings/github");

/** Repos the sidebar loaded: the drawer and the next sidebar render show them at once. */
const sidebarRepos = signal<RepoSummary[] | null>(null);
/** The repo the screen in view belongs to (its crumbs say so), so its link is the current one. */
const pageRepo = signal<string | null>(null);

/** Screens that live inside a repository: Dashboard is their ancestor, never their current item. */
const IN_REPO = /^\/(repos|changes|plans)\//;

const THEMES: { id: ThemePref; label: string; icon: IconId }[] = [
  { id: "system", label: "System", icon: "monitor" },
  { id: "light", label: "Light", icon: "sun" },
  { id: "dark", label: "Dark", icon: "moon" },
];

/** A radio group: one Tab stop (the checked option), arrows move the choice. */
function ThemeSwitch() {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = THEMES.length;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? (i + 1) % n
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? (i - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : -1;
    const opt = THEMES[next];
    if (!opt) return;
    e.preventDefault();
    themePref.value = opt.id;
    ref.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };
  return (
    <div class="theme-switch" role="radiogroup" aria-label="Theme" ref={ref}>
      {THEMES.map((o, i) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={themePref.value === o.id}
          tabIndex={themePref.value === o.id ? 0 : -1}
          class="theme-switch__opt"
          onClick={() => {
            themePref.value = o.id;
          }}
          onKeyDown={(e) => onKey(e, i)}
          title={o.label}
        >
          <Icon name={o.icon} size={16} />
          <span class="sr-only">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function DemoNote() {
  if (!isMockMode()) return null;
  return (
    <p class="demo-note">
      <Icon name="info" size={14} />
      Demo data. Every repo, person and number is synthetic.
    </p>
  );
}

/**
 * Search, places and repositories: the sidebar's body, and the drawer's. Exactly one link is
 * current: the repo you are in (on its changes, plans, queue and members too), else the place.
 */
function NavBody({ path }: { path: string }) {
  const repos = sidebarRepos.value;
  const inRepo = IN_REPO.test(path);
  const repoHere = /^\/repos\/([^/]+)/.exec(path)?.[1] ?? (inRepo ? pageRepo.value : null);
  return (
    <>
      <PaletteButton />
      <nav class="sidebar__nav" aria-label="Places">
        <ul>
          {NAV.map((n) => (
            <li key={n.href}>
              <a
                href={n.href}
                class="nav-link"
                aria-current={n.match(path) ? "page" : undefined}
                data-ancestor={n.href === "/dashboard" && inRepo ? "true" : undefined}
                target={n.server ? "_top" : undefined}
              >
                <Icon name={n.icon} />
                {n.label}
              </a>
            </li>
          ))}
        </ul>
        {repos && repos.length > 0 ? (
          <ul class="sidebar__repos" aria-label="Repositories">
            {repos.map((r) => (
              <li key={r.id}>
                <a
                  href={`/repos/${r.id}`}
                  class="repo-link"
                  aria-current={repoHere === r.id ? "page" : undefined}
                  data-testid="nav-repo"
                >
                  <span class="repo-link__name">{r.name}</span>
                  {r.counts.awaitingReview + (r.counts.plansAwaitingApproval ?? 0) > 0 ? (
                    <span
                      class="repo-link__count tnum"
                      aria-label={`${r.counts.awaitingReview} awaiting review, ${r.counts.plansAwaitingApproval ?? 0} plans to approve`}
                    >
                      {r.counts.awaitingReview + (r.counts.plansAwaitingApproval ?? 0)}
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </nav>
    </>
  );
}

function NavFoot() {
  const me = principal.value;
  const s = session.value;
  return (
    <>
      {me ? (
        <Who
          kind={me.kind}
          name={s.status === "authed" ? (s.me.user?.name ?? me.name) : me.name}
          compact
        />
      ) : null}
      <div class="sidebar__row">
        <ThemeSwitch />
        <button type="button" class="btn btn--quiet btn--sm" onClick={() => void signOut()}>
          <Icon name="log-out" />
          <span>Sign out</span>
        </button>
      </div>
      <DemoNote />
    </>
  );
}

function Sidebar() {
  const { path } = useLocation();
  useEffect(() => {
    api.repos().then(
      (r) => {
        sidebarRepos.value = r.repos;
        paletteRepos.value = r.repos.map((x) => ({ id: x.id, name: x.name, hosted: !!x.host }));
      },
      () => {},
    );
  }, [path]);
  return (
    <aside class="sidebar" aria-label="Navigation">
      <a href="/dashboard" class="brand" aria-label="gittifacts dashboard">
        <BrandMark />
        <span class="brand__word">gittifacts</span>
      </a>
      <NavBody path={path} />
      <div class="sidebar__foot">
        <NavFoot />
      </div>
    </aside>
  );
}

function NavDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { path } = useLocation();
  /** Closing because the page changed: focus belongs to the new page, not back on the menu button. */
  const navClose = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.classList.remove("is-closing");
      d.showModal();
    }
    if (!open && d.open && !d.classList.contains("is-closing")) {
      // Slide out first (layout.css drawer-out); a timer covers browsers that skip the animation.
      d.classList.add("is-closing");
      const done = () => {
        window.clearTimeout(t);
        d.classList.remove("is-closing");
        if (d.open) d.close();
        if (navClose.current) {
          navClose.current = false;
          document.getElementById("main")?.focus({ preventScroll: true });
        }
      };
      const t = window.setTimeout(done, 260);
      d.addEventListener("animationend", done, { once: true });
    }
  }, [open]);
  // The palette opened from the drawer's search field takes over: one sheet at a time.
  useEffect(() => {
    if (open && paletteOpen.value) onClose();
    // biome-ignore lint/correctness/useExhaustiveDependencies: only when the palette opens
  }, [paletteOpen.value]);
  useEffect(() => {
    if (open) {
      navClose.current = true;
      onClose();
    }
    // close on navigation
    // biome-ignore lint/correctness/useExhaustiveDependencies: only on path change
  }, [path]);
  return (
    <dialog
      ref={ref}
      class="drawer"
      aria-label="Menu"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div class="drawer__panel">
        <div class="drawer__head">
          <span class="brand">
            <BrandMark />
            <span class="brand__word">gittifacts</span>
          </span>
          <button type="button" class="icon-btn" onClick={onClose} aria-label="Close menu">
            <Icon name="x" size={22} />
          </button>
        </div>
        <div class="drawer__body">
          <NavBody path={path} />
        </div>
        <div class="drawer__foot">
          <NavFoot />
        </div>
      </div>
    </dialog>
  );
}

export interface Crumb {
  href: string;
  label: string;
}

interface PageProps {
  title: string;
  /** Back target on phone; on desktop rendered as breadcrumbs. */
  crumbs?: Crumb[];
  /** Extra controls in the header (right side on desktop). */
  actions?: ComponentChildren;
  /** Content under the title inside the header block. */
  meta?: ComponentChildren;
  children: ComponentChildren;
  /** Wider canvas for dense screens. */
  wide?: boolean;
  /** Replace the default phone top bar's title (e.g. the tour's compact progress). */
  barTitle?: ComponentChildren;
  class?: string;
}

export function Page({
  title,
  crumbs = [],
  actions,
  meta,
  children,
  wide,
  barTitle,
  class: cls,
}: PageProps) {
  const drawer = useSignal(false);
  const scrolled = useSignal(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · gittifacts`;
  }, [title]);
  // A change or plan names its repo in its crumbs: that repo's sidebar link is the current one.
  const repoCrumb =
    crumbs
      .map((c) => /^\/repos\/([^/?#]+)$/.exec(c.href)?.[1])
      .filter(Boolean)
      .pop() ?? null;
  useEffect(() => {
    pageRepo.value = repoCrumb ? decodeURIComponent(repoCrumb) : null;
  }, [repoCrumb]);
  useEffect(() => {
    const el = heading.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => {
        scrolled.value = entry ? !entry.isIntersecting : false;
      },
      { rootMargin: "-56px 0px 0px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scrolled]);
  const back = crumbs[crumbs.length - 1];
  return (
    <div class={`page ${wide ? "page--wide" : ""} ${cls ?? ""}`}>
      <header
        class="topbar"
        data-scrolled={scrolled.value || barTitle ? "true" : "false"}
        data-away={scrolled.value ? "true" : "false"}
        data-testid="topbar"
      >
        {back ? (
          <a href={back.href} class="topbar__back" aria-label={`Back to ${back.label}`}>
            <Icon name="chevron-left" size={24} />
            <span class="topbar__backlabel" aria-hidden="true">
              {back.label}
            </span>
          </a>
        ) : (
          <a href="/dashboard" class="topbar__brand" aria-label="gittifacts dashboard">
            <BrandMark />
            <span class="brand__word topbar__word" aria-hidden="true">
              gittifacts
            </span>
          </a>
        )}
        <div class="topbar__title" aria-hidden={barTitle ? undefined : "true"}>
          {barTitle ?? <span class="topbar__text">{title}</span>}
        </div>
        {/* Desktop: where you are, once the page's own crumbs and title have scrolled away. */}
        <nav class="topbar__crumbs" aria-label="Where you are">
          <ol>
            {crumbs.map((c) => (
              <li key={c.href}>
                <a href={c.href}>{c.label}</a>
              </li>
            ))}
            <li class="topbar__here">{title}</li>
          </ol>
        </nav>
        <PaletteButton compact />
        <button
          type="button"
          class="icon-btn topbar__menu"
          aria-label="Open menu"
          aria-haspopup="dialog"
          onClick={() => (drawer.value = true)}
        >
          <Icon name="menu" size={22} />
        </button>
      </header>
      <NavDrawer open={drawer.value} onClose={() => (drawer.value = false)} />
      <main id="main" class="page__main" tabIndex={-1}>
        <div class="page__head">
          {crumbs.length > 0 ? (
            <nav class="crumbs" aria-label="Breadcrumb">
              <ol>
                {crumbs.map((c) => (
                  <li key={c.href}>
                    <a href={c.href}>{c.label}</a>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
          <div class="page__titlerow">
            <h1 class="page__title" ref={heading}>
              {title}
            </h1>
            {actions ? <div class="page__actions">{actions}</div> : null}
          </div>
          {meta ? <div class="page__meta">{meta}</div> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

export function Shell({ children }: { children: ComponentChildren }) {
  usePaletteShortcut();
  return (
    <div class="shell">
      <a href="#main" class="skip-link">
        Skip to content
      </a>
      <Sidebar />
      <div class="shell__content">{children}</div>
      <Palette />
    </div>
  );
}
