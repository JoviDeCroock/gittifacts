/**
 * Top bar and first viewport: the rule, one line on what the platform does, the human action
 * (sign in) and the agent action (one URL), beside the case tag.
 */
import { type ComponentChildren, Fragment } from "preact";
import { BrandMark } from "../components/BrandMark.js";
import { Icon } from "../components/Icon.js";
import { CaseTag } from "./CaseTag.js";
import { CLI_PATH, DEFAULT_ORIGIN, urlParts } from "./content.js";

const NAV = [
  { href: "#loop", label: "How it works" },
  { href: "#migrate", label: "Migrate" },
  { href: "#agents", label: "For agents" },
  { href: "#rules", label: "Rules" },
];

export function TopBar() {
  return (
    <header class="topbar">
      <div class="topbar__inner">
        <a href="/" class="brand" aria-label="gittifacts home">
          <BrandMark size={24} />
          <span class="brand__word">gittifacts</span>
        </a>
        <nav class="topbar__nav" aria-label="Sections">
          <ul>
            {NAV.map((n) => (
              <li key={n.href}>
                <a href={n.href}>{n.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <a class="btn btn--secondary topbar__signin" href="/signin">
          Sign in
        </a>
        {/* Phones: the same sections behind a disclosure that needs no script. */}
        <details class="topbar__menu">
          <summary aria-label="Sections">
            <Icon name="menu" size={22} />
          </summary>
          <nav aria-label="Sections">
            <ul>
              {NAV.map((n) => (
                <li key={n.href}>
                  <a href={n.href}>{n.label}</a>
                </li>
              ))}
            </ul>
          </nav>
        </details>
      </div>
    </header>
  );
}

/** A URL with <wbr> break points (the Worker and client.ts rewrite it the same way). */
export function BreakableUrl({ url }: { url: string }) {
  return (
    <>
      {urlParts(url).map((part, i) => (
        <Fragment key={`${i}-${part}`}>
          {i > 0 ? <wbr /> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/** A small copy button for an inline value; client.ts enables it. */
export function CopyButton({ target, label }: { target: string; label: string }) {
  return (
    <button type="button" class="copybtn" data-copy={target} aria-label={label} hidden>
      <Icon name="copy" size={16} />
      <span class="copyline__done" aria-hidden="true">
        Copied
      </span>
    </button>
  );
}

/** A value with a copy button. The button is enabled by client.ts; without JS the text stays selectable. */
export function CopyLine({
  id,
  text,
  originPath,
  label,
  children,
  scroll = false,
}: {
  id: string;
  text?: string;
  originPath?: string;
  label: string;
  /** Mixed content, e.g. a command with an origin-rewritten URL inside it. */
  children?: ComponentChildren;
  /** Long commands scroll on one line at every width instead of breaking mid-word. */
  scroll?: boolean;
}) {
  return (
    <div class={scroll ? "copyline copyline--scroll" : "copyline"}>
      <code class="copyline__text" id={id} data-origin-text={originPath}>
        {children ??
          (originPath === undefined ? (
            text
          ) : (
            <BreakableUrl url={`${DEFAULT_ORIGIN}${originPath}`} />
          ))}
      </code>
      <button type="button" class="copyline__btn" data-copy={id} aria-label={label} hidden>
        <Icon name="copy" size={16} />
        <span class="copyline__done" aria-hidden="true">
          Copied
        </span>
      </button>
    </div>
  );
}

export function Hero() {
  return (
    <section class="hero-band" aria-labelledby="hero-title">
      <div class="hero wrap">
        <div class="hero__text">
          <h1 class="hero__title" id="hero-title">
            {/* Two parallel sentences, each broken after its verb. */}
            <span>Humans approve</span> <span>intent.</span> <span>Machines prove</span>{" "}
            <span>conformance.</span>
          </h1>
          <p class="hero__lede">
            gittifacts is the git platform for teams whose code is mostly written by agents. It
            routes each change to the cheapest review that is still safe, and makes it easy to undo
            after merge.
          </p>
          <div class="hero__actions">
            <a class="btn btn--primary hero__cta" href="/signin?mode=signup">
              Create an account
            </a>
            <div class="hero__agent">
              <p class="hero__agent-label">Or point your agent at</p>
              <CopyLine id="agent-url" originPath="/start" label="Copy the start URL" />
              <p class="hero__agent-label">Or, from a terminal</p>
              <CopyLine id="cli-init" label="Copy the init command" scroll>
                npx -y <span data-origin-text={CLI_PATH}>{`${DEFAULT_ORIGIN}${CLI_PATH}`}</span>{" "}
                --host <span data-origin-text="">{DEFAULT_ORIGIN}</span> init
              </CopyLine>
            </div>
          </div>
        </div>
        <div class="hero__tag">
          <CaseTag />
        </div>
      </div>
    </section>
  );
}
