# Impeccable: distilled design guide for gittifacts

Source: https://github.com/pbakaus/impeccable (Paul Bakaus), docs at https://impeccable.style. Skill v4.4.0, commit `c74755d` (main, 2026-10-01). License: **Apache 2.0**, so the skill can be redistributed. It is vendored verbatim at `.claude/skills/impeccable/` (with LICENSE, NOTICE.md and UPSTREAM.txt). Impeccable started from Anthropic's `frontend-design` skill and replaces it. For this project, "frontend-design with impeccable.style" means: **use the `impeccable` skill, and treat this file as the condensed rulebook.**

Provenance tags: **[v4]** is a current rule (SKILL.md, `craft-floor.md`, `operate.md`, command refs). **[det]** is one of the 61 deterministic detector rules. **[v3]** comes from the domain references that v4 retired (typography/color/spatial/motion/interaction/responsive/ux-writing). Those are still sound craft, but v4 treats them as defaults, not laws. Where the two disagree, v4 wins.

## 1. How Impeccable thinks (v4 model)

- **Three context files.** `PRODUCT.md` holds product truth: users, purpose, positioning, constraints, evidence. It never holds visuals; `/impeccable init` writes it. `DESIGN.md` plus `.impeccable/design.json` hold the built visual system as tokens, written after the build by the documenter. A per-surface brief holds the **Direction contract**: THESIS, OWN-WORLD, STORY, FIRST VIEWPORT, FORM, FINISH.
- **The mode is chosen per surface**, not per product. **Operate** (complete a task): approvals, lanes, evidence, rollout, audit log. **Read** (understand something): guided tours are mostly Read inside an Operate shell. **Persuade**: a future marketing page. **Experience**: portfolio-style work, not relevant here.
- **The Operate bar is "earned familiarity".** A category-fluent user should trust every component on sight. The failure mode is "strangeness without purpose": invented affordances, display fonts in labels, decorative motion. Brand lives in precise details. Delight goes into moments, not pages.
- **The brief wins.** Pinned fonts, palettes and eras override every "saturated pattern" warning. Refinement preserves the incumbent; redesign replaces it. Never split the difference.
- **Commit, then verify in bounded passes.** Build fully, then run one batched inspection at desktop and mobile together. Fix everything in one batch and confirm with at most one more round. **Two rounds is the ceiling.** After that, hand off to a fresh-context reviewer (finish review or critique) rather than self-polishing forever.
- **Pick the color strategy before picking colors.** **Restrained** (neutrals plus one accent) is the Operate default. The others are **Committed** (one saturated color carries 30-60% of the surface), **Full palette** (3-4 named roles) and **Drenched** (the surface is the color).
- **Never choose light or dark by category.** Write one sentence of physical scene (who, where, under what light, in what mood) and let it force the answer. "Dev tool, so dark" is exactly the reflex it bans.
- **The AI-slop self-check.** If someone could guess your aesthetic from the category alone ("dev tool → near-black + neon + mono"), or from the category plus what you avoided, rework it.

## 2. Concrete DO / DON'T rules

### Typography
- DO (Operate) [v4]: **one well-tuned family** for headings, buttons, labels, body and data. Use a **fixed rem scale, not fluid `clamp()`**, with a **1.125-1.2 step ratio**. System stacks and workhorse UI faces are legitimate for Operate and Read.
- DO [det]: keep at least one strong step. Heading vs body **≥1.25×** somewhere, or `flat-type-hierarchy` fires. Use the fewest roles that make hierarchy unmistakable: combine size, weight, space and tone, not size alone.
- DO [v4] sizing:
  - Body **16px / 1rem floor**. Inputs must be ≥16px, because iOS Safari zooms smaller inputs.
  - Body measure **65-75ch** (45-75 acceptable). Tables and dense UI can run 120ch+.
  - **Line-height ≥1.3** (body 1.5-1.7).
  - Functional UI text **never <11px**. Body never <12px; 14px is only for genuinely secondary text.
- DO [v4] tracking and display: tracking floor **-0.04em**; display max **6rem**; `text-wrap: balance` on headings. Wide tracking (0.05-0.12em) only for short uppercase labels, never body. All-caps never for passages.
- DO [v4/v3]: `font-variant-numeric: tabular-nums` for data (counts, durations, coverage %, SHAs in columns). Light text on dark needs compensation on three axes: line-height +0.05-0.1, tracking +0.01-0.02em, one weight step up.
- DO [v3]: load only the weights you use. Use `font-display: swap` (or `optional` when zero CLS matters) and metric-matched fallbacks (`size-adjust`, ascent/descent overrides). Name tokens by role (`--text-body`), not by value.
- DON'T [det]: use the overused faces **Inter, Roboto, Open Sans, Lato, Montserrat, Arial, Helvetica, Fraunces, Instrument Sans/Serif, Geist / Geist Sans / Geist Mono, Mona Sans, Plus Jakarta Sans, Space Grotesk, Recoleta**. new-work adds training-data defaults: Playfair, Cormorant, Lora, Crimson, Newsreader, Syne, Space Mono, IBM Plex, DM Sans/Serif, Outfit. Naming one of these needs a reason no other face could satisfy, and "tech wants mono" is not a reason.
- DON'T [v4]:
  - Use **monospace as a costume** for "technical". Mono is for code, diffs, hashes, data and measurement only.
  - Put display fonts in labels, buttons or data.
  - Add a second family without a role only it can perform.
  - Use paragraph spacing and first-line indent together.

### Color and contrast
- DO [v4]: build **roles, not swatches**: canvas and elevated surfaces; primary and secondary text; action, focus and selection; borders; success, warning, error, info; data categories. Use primitive tokens plus semantic tokens; themes remap the semantic layer only.
- DO [v4]: for a new web palette use **OKLCH**. Vary lightness and **reduce chroma near white and black**. Choose hue from product meaning, never from a category default.
- DO [v4]: the accent goes only on **primary action, current selection and state**, never decoration; rarity gives it force. Add a second neutral layer (slightly warmer or cooler) for toolbars and panels.
- DO [v3, softened in v4]: avoid `#000` and `#fff`. Tint neutrals toward the brand hue at **chroma 0.005-0.015**. v4 says to tint "only when the brand hue genuinely creates cohesion", and allows neutral gray when it serves the world.
- DO [v4]: contrast targets are **body and placeholder text ≥4.5:1**, **large text ≥3:1**, **controls, icons and focus indicators ≥3:1**. Check every state (hover, disabled, error, overlays) in **both themes**. Color is never the only code: pair it with text, shape, icon or position. This matters for red/green tests and risk lanes.
- DO [v4/v3]: compose dark mode, never invert it. Elevation comes from lighter surfaces (for example L 15/20/25%), not shadows. Avoid pure black and desaturate accents slightly. Prefer explicit colors over alpha stacks, which make contrast context-dependent.
- DON'T [det/v4]:
  - Put **gray text on a colored background**. Derive secondary text from that surface's hue.
  - Use the **AI palette** (purple/violet gradients, cyan/neon on dark), or **cream/beige** grounds by reflex.
  - Use **gradient text**, **glowing colored shadows** or zero-offset halos, radial halos or spotlight glows.
  - Put saturated accents on inactive states.

### Spacing, layout, depth
- DO [v4/v3]: use a documented scale on a **4-unit base**: 4, 8, 12, 16, 24, 32, 48, 64, 96. Use `gap` for sibling rhythm. Group by proximity before adding containers.
- DO [det/v4]:
  - **Tight groups, generous separation.** Avoid `monotonous-spacing`.
  - Put **more space above a heading than below it** (`heading-rhythm`).
  - Body text never touches the viewport edge: **≥16px gutter**, ideally 24-32. Avoid cramped padding.
- DO [v4]: apply the squint test. With detail blurred, the primary element, the secondary element and the groups still read in order. DOM and focus order match the visual order. Make responsiveness **structural** (reflow, collapse, reorder), not fluid type. Use container queries for components that appear in different contexts.
- DO [v4]: overlays must escape their container. Use `<dialog>`, the popover API, `position: fixed`, or a portal (`clipped-overflow-container`). Use a semantic z-index scale [v3]: dropdown 100 → sticky 200 → backdrop 300 → modal 400 → toast 500 → tooltip 600.
- DO [v4]: shadows carry an offset and a soft blur; if you can clearly see a shadow, it is too strong [v3]. Commit to either a defined edge or a soft elevation, never both (`gpt-thin-border-wide-shadow`).
- DON'T [v4]:
  - **Cards as the default container**, and never **cards nested in cards**. Use spacing, type and dividers inside a card.
  - **Identical icon + heading + text card grids** as page structure.
  - The **hero-metric template** (big number, small label, supporting stats, accent).
  - **Modal as first thought**. Exhaust inline and progressive alternatives first.

### Motion
- DO [v4]: use motion only to convey state: feedback, state change, continuity, reveal. Operate transitions take **150-250ms**. No orchestrated page-load sequences; product loads straight into the task.
- DO [v4] duration by distance and consequence: **100-150ms** feedback; **150-300ms** state change; **300-500ms** layout, overlay or view transition; **500-800ms** one authored focal entrance. Exits are faster than entrances ([v3]: about 75% of the entrance).
- DO [v4/v3]: use exponential ease-out: expo `cubic-bezier(0.16,1,0.3,1)`, quart `cubic-bezier(0.25,1,0.5,1)`, quint `cubic-bezier(0.22,1,0.36,1)`. Ease-in for exits is `cubic-bezier(0.7,0,0.84,0)`. Never plain `ease`.
- DO [v4]:
  - Keep content visible by default, so a failed script never hides the page (`content-hidden-at-rest`).
  - Use FLIP, transforms or `grid-template-rows` instead of animating width, height, top, left or margin (`layout-transition`).
  - Cap total stagger ([v3]: ≈50ms per item, ≤500ms total).
  - Apply `will-change` only during the animation.
- DO [v4]: give `prefers-reduced-motion` an **intentional alternative**. Remove spatial movement but keep opacity, color and state feedback. A global `0.01ms` kill that erases feedback is flagged by audit.
- DON'T [det]: **bounce or elastic easing**; **pulsing status dots** unless tied to genuinely live, changing data (a static, labeled indicator is preferred); decorative blinking cursors; marquees; image scale or rotate on hover.

### Interaction states and focus
- DO [v4]: every control ships **default, hover, focus, active, disabled, loading, error and success**. Hover and focus are different states, and keyboard users never see hover.
- DO [v3]: never use `outline: none` without a replacement. Use `:focus-visible` with a **2-3px ring, offset 2px, ≥3:1** contrast against adjacent colors, consistent everywhere.
- DO [v4]: theme the browser surfaces you didn't draw: selection color, caret, scrollbars, focus ring, underline offset, tabular numerals. Craft-floor calls this "the cheapest signal that a page was built rather than assembled".
- DO [v3/v4]:
  - **Undo over confirm** for recoverable destructive actions.
  - Confirm only irreversible or high-cost actions, and name the action on the button ("Reject plan", not "Yes").
  - Prevent double-submit.
  - Use optimistic UI only for low-stakes actions, never for approvals or merges.
- DO [v3]: use visible `<label>`s, never placeholder-as-label. Validate on blur and put errors below the field with `aria-describedby`. Use roving tabindex in tab, radio and menu groups. Keyboard shortcuts belong on desktop (power-user persona "Alex").

### Empty, loading, error states
- DO [v4]: loading uses **skeletons shaped like the content**, not spinners mid-content. Name the real operation ("Running 412 tests…"), never "Loading…". Show determinate progress when known and **never invent progress**.
- DO [v4]: distinguish empty states by type. **First use**: teach the value and give the first action. **User cleared**: a light touch. **No results / filtered**: show the active filter and a "clear filters" action. **No permission**: why, and how to get access. **Failed to load**: what failed, plus retry. Empty states are onboarding moments, not "Nothing here".
- DO [v4]: every error answers **what failed, why (when known), and how to recover**. Internal codes are never the primary message, there is no blame, and **no humor on errors**. Map 400, 401, 403, 404, 429 and 500 to distinct UI. One failing component never blocks the whole interface.
- DO [v4 harden]: test extremes: 100+ character names, emoji, RTL, CJK, 1000+ items (virtualize or paginate), offline and 3G, 10 rapid taps, 200% zoom, German at about +30% length. Use `min-width: 0` on flex and grid children, logical properties (`margin-inline-start`), and `Intl` for dates and numbers. Pluralize via i18n, not `count !== 1 ? 's' : ''`.

### Mobile-first ergonomics
- DO [v3]: write base styles for mobile and layer up with `min-width` queries. Use content-driven breakpoints (often about 640/768/1024). Detect input with `@media (pointer: coarse)` and `(hover: none)`. **Never put functionality behind hover.**
- DO [v4]:
  - **Touch targets ≥44×44px.** The visible mark can be smaller if a pseudo-element expands the hit area.
  - **Primary actions in the thumb zone** (bottom half).
  - Bottom sheets instead of dropdowns. Sticky header for context.
  - Progressive disclosure: secondary content goes in tabs, accordions or `<details>`.
- DO [v4]: preserve state across interruption, since the user leaves mid-review and comes back. Handle safe areas with `viewport-fit=cover` and `env(safe-area-inset-*)`, e.g. `padding-bottom: max(1rem, env(safe-area-inset-bottom))`. Lazy-load off-screen content.
- DO [v4]: custom gestures (swipe-to-approve, drag) must survive `pointercancel`, lost capture, second fingers and scrolling across the control. Always provide a visible non-gesture fallback.
- DON'T: hide core functionality on mobile. Don't use a different information architecture per breakpoint. Never set `user-scalable=no`.

### Copy (UX writing)
- DO [v4]: controls name their action as verb plus object: "Approve plan", "Open tour", "Roll back". Keep one term per concept app-wide and maintain a glossary (lane, plan, tour, evidence, rollout). Say each idea once; if the heading explains it, delete the intro.
- DON'T [det/v4]: "OK", "Submit", "Yes/No", "Click here"; marketing buzzwords (streamline, empower, supercharge, world-class, enterprise-grade, cutting-edge); aphoristic cadence ("Not a feature. A platform."); calling things "theater"; em-dash saturation; the same text repeated three or more times inside one container.

## 3. The banned AI-slop list (exact v4 set)

**Craft-floor "Refuse" list [v4].** These are defaults the brief can earn back, with one exception: the **kicker/eyebrow above a heading is banned outright**, and no brief earns it back.
- **Page scaffolds:** same-size icon + heading + text cards as page structure; nested cards (always wrong); the hero-metric template; section numbers 01/02/03; unneeded modals.
- **Surface habits:** gradient text; glass and blur as decoration; colored **`border-left/right` >1px** on cards, list items, callouts or alerts; hard offset shadows (`4px 4px 0`) outside a genuinely neobrutalist world; **sparklines, progress rings and soft rounded rectangles standing in for content**; monospace as costume; system display faces as an own-world display voice; **emoji or Unicode glyphs as icons** (use one real icon library, one stroke weight); geometric masks faking organic contours; light or dark chosen by category.

**The 61 detector rules [det]**, grouped as on https://impeccable.style/slop:

| Group | Rules |
|---|---|
| Visual | decorative grid-line background; border accent on rounded element; side-tab accent border; hairline border + wide shadow; repeating-gradient stripes |
| Type | kicker/label above heading; hero eyebrow/pill chip; icon tile stacked above heading; italic serif display headline; oversized full-sentence H1; flat hierarchy; crushed tracking; overused font; tiny UI text (<11px); all-caps body |
| Color | AI palette; cream/beige; gradient text; dark glow; radial halo; radial spotlight; gray-on-color; low contrast |
| Layout | numbered section labels; nested cards; monotonous spacing; heading rhythm; line length >~80ch; text overflow; text occlusion; edge-flush cards in scrollers; unbalanced first-viewport columns; clipped overflow popovers |
| Motion | bounce/elastic easing; pulsing dot; blinking cursor; marquee; layout-property animation; image hover transform |
| Copy | em-dash overuse; marketing buzzwords; aphoristic cadence; "theater" framing; repeated text in one container |
| Imagery | shape-assembled SVG illustration; organic clip-path; raster buried under wash; broken image |
| Quality | script error on load; content hidden at rest; cramped padding; body text at viewport edge; justified text; skipped heading level; tight leading; tiny body text; wide tracking on body |
| DESIGN.md drift | font, color, radius or font-size outside DESIGN.md |

**Six LLM-only checks** have no detector and are judged in critique: glassmorphism everywhere; extreme border-radius on cards; rough SVG illustrations; single font for everything; hero-metric layout; identical card grids. "Single font" is a *Persuade* concern. For Operate, `operate.md` explicitly says one family is often right.

## 4. Traps specific to this product

- **Risk lanes 0/1/2.** Do not encode a lane as a colored left stripe on a card; that is the #1 detector rule. Encode it with a named label plus shape or icon, grouping or position (a section per lane), and a surface tint derived from the lane hue. Never rely on color alone.
- **Evidence detail** (tests, coverage, API diffs) is content, not decoration. Show real numbers and real diffs in mono, because that is legitimate data use. Don't use progress rings or sparklines as stand-ins. Don't nest cards inside an evidence card. Tabular numerals throughout.
- **The terminal costume.** Don't make the whole UI look like a terminal, an IDE or a control panel. new-work forbids drawing an Operate surface's world from "the tools the audience operates". Also avoid near-black + neon + glow (the `ai-color-palette` and `dark-glow` rules).
- **Rollout/watch status.** A pulse is allowed only while data is genuinely live. Otherwise use a static labeled state ("Watching · 12 min, 0 errors"). Error-budget numbers stay visible and are not hidden behind hover.
- **Approvals are trust moments.**
  - Use pessimistic UI: wait for the server, then confirm.
  - Name the consequence ("Approve plan; 3 files will auto-merge").
  - Offer undo where the system can honor it, and use specific button labels.
  - Keep primary actions in the thumb zone, and never modal-first.
- **Guided tours** follow Read-mode rules: 65-75ch prose, real code excerpts, `text-wrap: pretty`; progress "step 2 of 5" (onboard: 3-7 steps per tour); skippable and resumable after interruption.
- **Audit log** (Operate, dense): fixed rem scale, tabular numerals, `Intl` timestamps, virtualized long lists, and empty and filtered states that teach.
- **Personas critique will use:** Casey (distracted one-handed mobile), Alex (power user), Sam (accessibility). Add a project persona, e.g. "on-call reviewer approving from a phone between meetings".

## 5. Command workflow for a new product UI

All commands run as `/impeccable <cmd> [target]` (`teach` is an alias of `init`). The full list of 24:
- **Build:** `craft` (deprecated alias of plain new-work), `shape`, `init`, `document`, `extract`
- **Evaluate:** `critique`, `audit`
- **Refine:** `polish`, `bolder`, `quieter`, `distill`, `harden`, `onboard`
- **Enhance:** `animate`, `colorize`, `typeset`, `layout`, `delight`, `overdrive`
- **Fix:** `clarify`, `adapt`, `optimize`
- **Iterate:** `live`, `generate`

Plus utilities: `pin`/`unpin`, `hooks`, `doctor`.

Recommended order for gittifacts:
1. **`/impeccable init`** writes PRODUCT.md: users, jobs, positioning, constraints, evidence, `## Platform: web`, `## Stack: Preact + signals`. It asks product questions only, no aesthetics. Record `buildPath` (comp-first vs code-first) in `.impeccable/config.json`.
2. **`/impeccable shape <surface>`** runs per key surface (approval inbox, lane view, guided tour, evidence detail, rollout, audit log). It produces a confirmed brief with task, states, data ranges and constraints. It writes no code.
3. **Build (plain request, i.e. new-work).** The first surface creates the visual world: seven grounded candidates, then `impeccable concept-seed --scope direction --mode operate` (mandatory before artifact code), then one committed direction. Record the six-block Direction contract in the surface brief, then build fully committed. Later surfaces inherit the world and use `--scope surface`. Read `reference/craft-floor.md` immediately before every UI edit.
4. **Inspect:** one batched desktop + **mobile (390px)** screenshot round, then `impeccable detect --json`. Hand off to the `impeccable-finish-reviewer` subagent; it is not installed here, so use `reference/degraded/finish-reviewer.md`. Then the documenter writes **DESIGN.md + `.impeccable/design.json`**.
5. **`/impeccable critique <surface>`**: Nielsen 10 scored 0-4, a design-specificity verdict, cognitive load (≤4 options per decision), personas, and P0-P3 issues. It runs two isolated subagents and persists a snapshot.
6. **`/impeccable audit <surface>`**: technical score /20 across a11y, performance, theming, responsive and implementation integrity, P0-P3. It reports and does not fix.
7. **Targeted fixes**, as the findings indicate: `harden` (errors, i18n, overflow, offline), `onboard` (empty states, first-run), `clarify` (copy), `adapt` (mobile ergonomics), and `typeset`, `layout`, `colorize`, `animate`, or `quieter`/`distill` (density and noise).
8. **`/impeccable polish <surface>`**: final pass. It reads the latest critique snapshot as its backlog and triages broken flows → missing states → drift → visual → cleanup.
9. **`/impeccable extract`** promotes reusable tokens and components (Preact components plus signals-driven state primitives). Re-run `document` after system changes.

The website's short version is: install → `init` → describe what to build (or `shape` first) → refine (`layout`, `typeset`, `colorize`, `animate`, `delight`, `live`) → `critique` → `audit` → `polish`.

## 6. Tooling notes

- `scripts/impeccable` is a shell launcher. On first run it downloads a self-contained engine binary (engine v0.1.9) from GitHub releases into `~/.impeccable/bin/`, verified against a `.sha256` sidecar. It provides `context`, `detect`, `concept-seed`, `surface-brief`, `critique-storage`, `serve-question`, `live` and others. If it can't run, SKILL.md's "Launcher unavailable" path applies: say so, read PRODUCT.md and DESIGN.md directly, and continue.
- Not installed into this project: the upstream subagents (`.claude/agents/impeccable-{finish-reviewer,documenter,asset-producer,manual-edit-applier}.md`) and the detector hooks (`.claude/settings.json`: PostToolUse on Edit/Write and Stop). Both are staged in the session scratchpad under `impeccable/optional-claude-config/` if wanted. Without them, the skill uses `reference/degraded/*.md`, and you should run `impeccable detect --json` manually once per build.
- `/impeccable live` and `generate` need a running dev server (web only).
