/**
 * The marketing landing page, served at `/` to everyone (the app is /dashboard). Static HTML, no
 * hydration: client.ts only adds copy buttons, the theme switch and the nav's session link.
 */
import { GITHUB_SURFACES } from "@app/domain/surfaces";
import { Agents } from "./Agents.js";
import { Close, Footer } from "./Close.js";
import { Hero, TopBar } from "./Hero.js";
import { Loop } from "./Loop.js";
import { Migrate } from "./Migrate.js";
import { Rules } from "./Rules.js";
import { Shift } from "./Shift.js";

export function Landing() {
  return (
    <>
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <TopBar />
      <main id="main">
        <Hero />
        <Shift />
        <Loop />
        {GITHUB_SURFACES ? <Migrate /> : null}
        <Agents />
        <Rules />
        <Close />
      </main>
      <Footer />
      <p class="sr-only" id="copy-status" aria-live="polite" />
    </>
  );
}
