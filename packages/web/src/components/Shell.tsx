/**
 * App frame. Phone: a sticky top bar with back/title/menu and a nav drawer. Desktop (≥1024px):
 * a fixed sidebar with the same destinations. One information architecture at every width.
 */
import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useLocation } from "preact-iso";
import { useEffect, useRef } from "preact/hooks";
import { api } from "../api/client.js";
import { isMockMode } from "../api/mode.js";
import type { RepoSummary } from "../api/types.js";
import { principal, session, signOut } from "../state/session.js";
import { type ThemePref, themePref } from "../state/prefs.js";
import { Icon, type IconId } from "./Icon.js";
import { Who } from "./ui.js";

export function BrandMark({ size = 22 }: { size?: number }) {
  const w = Math.round(size * 1.45);
  return (
    <svg class="brand-mark" width={w} height={size} viewBox="0 0 32 22" aria-hidden="true" focusable="false">
      <path
        d="M7.5 1 H29 Q31 1 31 3 V19 Q31 21 29 21 H7.5 L1 14.2 V7.8 Z M11.4 11 a2.2 2.2 0 1 0 -4.4 0 a2.2 2.2 0 1 0 4.4 0 Z"
        fill-rule="evenodd"
      />
      <path d="M16 7.2 h10.5 M16 11 h10.5 M16 14.8 h6.5" class="brand-mark__lines" />
    </svg>
  );
}

const NAV: { href: string; label: string; icon: IconId; match: (path: string) => boolean }[] = [
  { href: "/", label: "Repositories", icon: "layers", match: (p) => p === "/" || p.startsWith("/repos") || p.startsWith("/changes") || p.startsWith("/plans") },
  { href: "/audit", label: "Audit log", icon: "scroll-text", match: (p) => p.startsWith("/audit") },
  { href: "/agents", label: "Agents", icon: "key", match: (p) => p.startsWith("/agents") },
];

const sidebarRepos = { value: null as RepoSummary[] | null };

function ThemeSwitch() {
  const opts: { id: ThemePref; label: string; icon: IconId }[] = [
    { id: "system", label: "System", icon: "monitor" },
    { id: "light", label: "Light", icon: "sun" },
    { id: "dark", label: "Dark", icon: "moon" },
  ];
  return (
    <div class="theme-switch" role="radiogroup" aria-label="Theme">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={themePref.value === o.id}
          class="theme-switch__opt"
          onClick={() => {
            themePref.value = o.id;
          }}
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

function Sidebar() {
  const { path } = useLocation();
  const repos = useSignal<RepoSummary[] | null>(sidebarRepos.value);
  useEffect(() => {
    let live = true;
    api.repos().then(
      (r) => {
        sidebarRepos.value = r.repos;
        if (live) repos.value = r.repos;
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [path, repos]);
  const me = principal.value;
  const s = session.value;
  return (
    <aside class="sidebar" aria-label="Main">
      <a href="/" class="brand">
        <BrandMark />
        <span class="brand__word">gittifacts</span>
      </a>
      <nav class="sidebar__nav">
        <ul>
          {NAV.map((n) => (
            <li key={n.href}>
              <a href={n.href} class="nav-link" aria-current={n.match(path) ? "page" : undefined}>
                <Icon name={n.icon} />
                {n.label}
              </a>
            </li>
          ))}
        </ul>
        {repos.value && repos.value.length > 0 ? (
          <ul class="sidebar__repos" aria-label="Repositories">
            {repos.value.map((r) => (
              <li key={r.id}>
                <a href={`/repos/${r.id}`} class="repo-link" aria-current={path.startsWith(`/repos/${r.id}`) ? "page" : undefined}>
                  <span class="repo-link__name">{r.name}</span>
                  {r.counts.awaitingReview > 0 ? (
                    <span class="repo-link__count tnum" aria-label={`${r.counts.awaitingReview} awaiting review`}>
                      {r.counts.awaitingReview}
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </nav>
      <div class="sidebar__foot">
        {me ? <Who kind={me.kind} name={s.status === "authed" ? (s.me.user?.name ?? me.name) : me.name} compact /> : null}
        <div class="sidebar__row">
          <ThemeSwitch />
          <button type="button" class="btn btn--quiet btn--sm" onClick={() => void signOut()}>
            <Icon name="log-out" />
            <span>Sign out</span>
          </button>
        </div>
        <DemoNote />
      </div>
    </aside>
  );
}

function NavDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { path } = useLocation();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    if (open) onClose();
    // close on navigation
    // biome-ignore lint/correctness/useExhaustiveDependencies: only on path change
  }, [path]);
  const me = principal.value;
  const s = session.value;
  return (
    <dialog
      ref={ref}
      class="drawer"
      aria-label="Menu"
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
        <nav>
          <ul class="drawer__nav">
            {NAV.map((n) => (
              <li key={n.href}>
                <a href={n.href} class="nav-link" aria-current={n.match(path) ? "page" : undefined}>
                  <Icon name={n.icon} />
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div class="drawer__foot">
          {me ? <Who kind={me.kind} name={s.status === "authed" ? (s.me.user?.name ?? me.name) : me.name} compact /> : null}
          <div class="sidebar__row">
            <ThemeSwitch />
            <button type="button" class="btn btn--quiet btn--sm" onClick={() => void signOut()}>
              <Icon name="log-out" />
              <span>Sign out</span>
            </button>
          </div>
          <DemoNote />
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

export function Page({ title, crumbs = [], actions, meta, children, wide, barTitle, class: cls }: PageProps) {
  const drawer = useSignal(false);
  const scrolled = useSignal(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · gittifacts`;
  }, [title]);
  useEffect(() => {
    const el = heading.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => {
      scrolled.value = entry ? !entry.isIntersecting : false;
    }, { rootMargin: "-56px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [scrolled]);
  const back = crumbs[crumbs.length - 1];
  return (
    <div class={`page ${wide ? "page--wide" : ""} ${cls ?? ""}`}>
      <header class="topbar" data-scrolled={scrolled.value || barTitle ? "true" : "false"}>
        {back ? (
          <a href={back.href} class="topbar__back" aria-label={`Back to ${back.label}`}>
            <Icon name="chevron-left" size={24} />
            <span class="topbar__backlabel" aria-hidden="true">
              {back.label}
            </span>
          </a>
        ) : (
          <a href="/" class="topbar__brand" aria-label="gittifacts home">
            <BrandMark />
            <span class="brand__word topbar__word" aria-hidden="true">
              gittifacts
            </span>
          </a>
        )}
        <div class="topbar__title" aria-hidden={barTitle ? undefined : "true"}>
          {barTitle ?? <span class="topbar__text">{title}</span>}
        </div>
        <button type="button" class="icon-btn" aria-label="Open menu" aria-haspopup="dialog" onClick={() => (drawer.value = true)}>
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
  return (
    <div class="shell">
      <a href="#main" class="skip-link">
        Skip to content
      </a>
      <Sidebar />
      <div class="shell__content">{children}</div>
    </div>
  );
}
