/**
 * Top bar and first viewport: the rule, one line on what the platform does, the human action
 * (sign in) and the agent action (one URL), beside the case tag.
 */
import { BrandMark } from "../components/BrandMark.js";
import { Icon } from "../components/Icon.js";
import { CaseTag } from "./CaseTag.js";
import { DEFAULT_ORIGIN } from "./content.js";

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
        <a class="btn btn--secondary btn--sm topbar__signin" href="/signin">
          Sign in
        </a>
      </div>
    </header>
  );
}

/** A value with a copy button. The button is enabled by client.ts; without JS the text stays selectable. */
export function CopyLine({
  id,
  text,
  originPath,
  label,
}: {
  id: string;
  text?: string;
  originPath?: string;
  label: string;
}) {
  return (
    <div class="copyline">
      <code class="copyline__text" id={id} data-origin-text={originPath}>
        {originPath === undefined ? text : `${DEFAULT_ORIGIN}${originPath}`}
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
            <span>Humans approve intent.</span> <span>Machines prove conformance.</span>
          </h1>
          <p class="hero__lede">
            gittifacts is the git platform for teams whose code is mostly written by agents. It
            routes each change to the cheapest review that is still safe, and makes it easy to undo
            after merge.
          </p>
          <div class="hero__actions">
            <a class="btn btn--primary hero__cta" href="/signin">
              Sign in to review
            </a>
            <div class="hero__agent">
              <p class="hero__agent-label">Or point your agent at</p>
              <CopyLine id="agent-url" originPath="/start" label="Copy the start URL" />
              <p class="hero__cli">
                From a terminal: <code>npx gittifacts init</code>
              </p>
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
