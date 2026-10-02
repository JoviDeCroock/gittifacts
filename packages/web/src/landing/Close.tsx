/**
 * The close: what it runs on, the two actions again, and the footer with the machine documents.
 */
import { BrandMark } from "../components/BrandMark.js";
import { Icon, type IconId } from "../components/Icon.js";
import { CopyLine } from "./Hero.js";

export function Close() {
  return (
    <section class="close-band" aria-labelledby="close-title">
      <div class="close wrap">
        <h2 class="close__title" id="close-title">
          Start with one change.
        </h2>
        <p class="l-lede">Approve a plan, read a tour, or let an agent find its own way in.</p>
        <div class="close__actions">
          <a class="btn btn--primary hero__cta" href="/signin?mode=signup">
            Create an account
          </a>
          <CopyLine id="agent-url-3" originPath="/start" label="Copy the start URL" />
        </div>
      </div>
    </section>
  );
}

const THEMES: { id: "system" | "light" | "dark"; label: string; icon: IconId }[] = [
  { id: "system", label: "System", icon: "monitor" },
  { id: "light", label: "Light", icon: "sun" },
  { id: "dark", label: "Dark", icon: "moon" },
];

const LINKS = [
  { href: "/docs", label: "Documentation" },
  { href: "/start", label: "Start guide for agents" },
  { href: "/docs/llms-full.txt", label: "Docs for agents (llms-full.txt)" },
  { href: "/llms.txt", label: "llms.txt" },
  { href: "/openapi.json", label: "OpenAPI" },
  { href: "/mcp/server-card", label: "MCP server card" },
];

export function Footer() {
  return (
    <footer class="footer">
      <div class="wrap footer__inner">
        <div class="footer__brand">
          <a href="/" class="brand" aria-label="gittifacts home">
            <BrandMark size={22} />
            <span class="brand__word">gittifacts</span>
          </a>
          <p>
            Screens and the example change use demo data. Measurements are from the live platform,
            October 2026.
          </p>
        </div>
        <nav class="footer__links" aria-label="For agents and developers">
          <ul>
            {LINKS.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
            <li>
              <a href="/signin">Sign in</a>
            </li>
          </ul>
        </nav>
        <fieldset class="footer__theme" hidden>
          <legend class="sr-only">Theme</legend>
          {THEMES.map((t) => (
            <label key={t.id} title={t.label}>
              <input type="radio" name="theme" value={t.id} />
              <Icon name={t.icon} size={18} />
              <span class="sr-only">{t.label}</span>
            </label>
          ))}
        </fieldset>
      </div>
    </footer>
  );
}
