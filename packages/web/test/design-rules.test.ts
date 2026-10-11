/**
 * DESIGN.md's named rules, enforced. A failure here means a stylesheet broke a rule the design
 * system depends on; the message names the rule and where DESIGN.md explains it. Change the rule
 * (DESIGN.md + DECISIONS.md + this list) before you change the stylesheet, never the other way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssFiles, type Decl, declarations, rel, topLevelItems } from "./css-walk.js";

const ROOT = join(import.meta.dirname, "..");
const APP = join(ROOT, "src/styles");
const LANDING = join(ROOT, "src/landing/styles");
const where = (d: Decl) => `${d.file}:${d.line} ${d.selector} { ${d.property}: ${d.value} }`;
const all = (dir: string) => cssFiles(dir).flatMap((f) => declarations(f, rel(ROOT, f)));
const app = all(APP);
const everything = [...app, ...all(LANDING)];

/**
 * The Acetate Rule (DESIGN.md, Elevation & Depth): only chrome that floats over a scrolling chart
 * wears acetate. Add a surface here only together with DESIGN.md's list.
 */
const ACETATE_SURFACES = [
  ".topbar",
  ".stations",
  ".tour__bar",
  ".plan-bar",
  ".kill-bar",
  ".palette",
];
const onSurface = (selector: string) =>
  ACETATE_SURFACES.some((s) => new RegExp(`^${s.replace(".", "\\.")}(?![\\w-])`).test(selector));

/** Loops allowed to run forever (DESIGN.md, Motion): loading feedback and a working agent's trace. */
const LOOPS = new Set(["spin", "shimmer", "fleet-trace"]);

/** A non-zero time literal (`0s` is a discrete switch, e.g. visibility, not a timing choice). */
const TIME = /(?<![\w.-])(?!0+m?s\b)(?!0*\.0+m?s\b)-?\d*\.?\d+m?s\b/;
const withoutVars = (v: string) => v.replace(/var\([^()]*(\([^()]*\))?[^()]*\)/g, "var()");

describe("the Acetate Rule", () => {
  it("blurs only through --acetate-filter, on the listed surfaces (scrims excepted)", () => {
    const bad = everything.filter((d) => {
      if (d.property !== "backdrop-filter" && d.property !== "-webkit-backdrop-filter")
        return false;
      if (d.selector.includes("::backdrop")) return !/^blur\([0-4]px\)$/.test(d.value);
      return d.value !== "var(--acetate-filter)" || !onSurface(d.selector);
    });
    expect(
      bad.map(where),
      "backdrop-filter outside the Acetate Rule (DESIGN.md, Elevation & Depth)",
    ).toEqual([]);
  });

  it("uses the acetate grounds only on the listed surfaces", () => {
    const bad = everything.filter(
      (d) =>
        /^background(-color)?$/.test(d.property) &&
        /var\(--acetate/.test(d.value) &&
        !onSurface(d.selector),
    );
    expect(
      bad.map(where),
      "an acetate ground outside the listed surfaces (DESIGN.md, the Acetate Rule)",
    ).toEqual([]);
  });

  it("falls back to solid ground when transparency is reduced, contrast is raised or blur is missing", () => {
    const tokens = readFileSync(join(APP, "tokens.css"), "utf8");
    expect(tokens).toMatch(
      /@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\) \{[^}]*--acetate-filter: none;/,
    );
    expect(tokens).toMatch(
      /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/,
    );
  });
});

describe("Motion", () => {
  it("times every transition and animation with a --dur-* token", () => {
    const clamp = (d: Decl) =>
      d.file.endsWith("base.css") &&
      d.context.some((c) => c.includes("prefers-reduced-motion: reduce"));
    const bad = everything.filter((d) => {
      if (clamp(d)) return false;
      if (/^(transition|animation)-duration$/.test(d.property))
        return TIME.test(withoutVars(d.value));
      if (d.property !== "transition" && d.property !== "animation") return false;
      // In a shorthand the first time is the duration; a later one (the delay) may be a literal.
      return topLevelItems(d.value).some((item) => {
        const plain = withoutVars(item);
        const lit = plain.search(TIME);
        const tok = item.indexOf("var(--dur-");
        return lit >= 0 && (tok < 0 || withoutVars(item.slice(0, tok)).search(TIME) >= 0);
      });
    });
    expect(bad.map(where), "a raw duration: name it in tokens.css (DESIGN.md, Motion)").toEqual([]);
  });

  it("loops forever only for loading feedback and a working agent's trace", () => {
    const bad = everything.filter(
      (d) =>
        (d.property === "animation" || d.property === "animation-iteration-count") &&
        /\binfinite\b/.test(d.value) &&
        !topLevelItems(d.value).every(
          (i) => !/\binfinite\b/.test(i) || LOOPS.has(i.split(/\s+/)[0] ?? ""),
        ),
    );
    expect(
      bad.map(where),
      "an endless animation that isn't loading feedback or the agent trace (DESIGN.md: no pulsing live dots)",
    ).toEqual([]);
  });

  it("keeps the reduced-motion clamp: travel removed, state changes kept", () => {
    const base = readFileSync(join(APP, "base.css"), "utf8");
    expect(base).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{[^}]*transition-property: color, background-color, border-color, opacity/,
    );
  });
});

describe("Colour", () => {
  it("lives in tokens.css only (the app's stylesheets reference tokens)", () => {
    const literal = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch|color)\(/i;
    const bad = app.filter(
      (d) =>
        !d.file.endsWith("tokens.css") &&
        literal.test(withoutVars(d.value)) &&
        !/^--/.test(d.property),
    );
    expect(bad.map(where), "a colour literal outside tokens.css (DESIGN.md, Colors)").toEqual([]);
  });
});
