/**
 * Build-time entry (landing.vite.ts): renders the landing page to static HTML.
 */
import prerender from "preact-iso/prerender";
import { Landing } from "./Landing.js";

export async function renderLanding(): Promise<string> {
  const { html } = await prerender(<Landing />);
  // preact-iso appends an empty hydration-data script; the page never hydrates.
  return html.replace('<script type="isodata"></script>', "");
}
