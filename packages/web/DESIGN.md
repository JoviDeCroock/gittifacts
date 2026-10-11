---
name: gittifacts
description: Review agent-written changes by their evidence. Triage tags and observation charts for code review.
colors:
  form-paper: "oklch(98.3% 0.004 250)"
  sheet: "oklch(99.5% 0.002 250)"
  panel: "oklch(96.4% 0.006 250)"
  panel-strong: "oklch(94% 0.008 250)"
  hairline: "oklch(90.5% 0.01 250)"
  hairline-strong: "oklch(84.5% 0.013 252)"
  ink: "oklch(23% 0.035 262)"
  ink-2: "oklch(42% 0.028 258)"
  ink-3: "oklch(51% 0.024 256)"
  ink-4: "oklch(62% 0.02 254)"
  scrub-teal: "oklch(47% 0.088 196)"
  scrub-teal-deep: "oklch(40% 0.078 198)"
  scrub-teal-tint: "oklch(95.5% 0.025 192)"
  focus-teal: "oklch(55% 0.1 194)"
  tag-carmine: "oklch(52% 0.175 27)"
  carmine-ink: "oklch(46% 0.16 27)"
  carmine-tint: "oklch(96% 0.02 25)"
  tag-ochre: "oklch(84% 0.13 82)"
  ochre-edge: "oklch(64% 0.12 74)"
  ochre-ink: "oklch(50% 0.1 70)"
  ochre-tint: "oklch(97% 0.03 88)"
  tag-green: "oklch(52% 0.115 152)"
  green-ink: "oklch(45% 0.1 152)"
  green-tint: "oklch(96.5% 0.025 155)"
  night: "oklch(17.5% 0.016 258)"
  night-sheet: "oklch(20.5% 0.018 258)"
  night-panel: "oklch(23.5% 0.02 258)"
  night-ink: "oklch(94% 0.008 250)"
  night-teal: "oklch(76% 0.105 190)"
typography:
  display:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 720
    lineHeight: 1.25
    letterSpacing: "-0.012em"
  headline:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.4375rem"
    fontWeight: 720
    lineHeight: 1.25
    letterSpacing: "-0.012em"
  title:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 720
    lineHeight: 1.3
  body:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  reading:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 560
    lineHeight: 1.2
  meta:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.45
  code:
    fontFamily: "Atkinson Hyperlegible Mono Variable, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.6
  landing-display:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.625rem"
    fontWeight: 760
    lineHeight: 1
    letterSpacing: "-0.032em"
  landing-headline:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 740
    lineHeight: 1.12
    letterSpacing: "-0.024em"
  landing-lede:
    fontFamily: "Atkinson Hyperlegible Next Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  mark: "2px"
  tag: "3px"
  chip: "6px"
  control: "8px"
  panel: "12px"
  sheet: "18px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
  "7": "48px"
  "8": "64px"
components:
  button-primary:
    backgroundColor: "{colors.scrub-teal}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.scrub-teal-deep}"
    textColor: "{colors.sheet}"
  button-secondary:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "{colors.panel}"
  button-danger:
    backgroundColor: "{colors.carmine-ink}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.control}"
    height: "44px"
  input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
    height: "44px"
  chip-status:
    backgroundColor: "{colors.panel-strong}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.chip}"
    padding: "1px 8px 1px 6px"
    height: "24px"
  evidence-chip:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "36px"
  lane-tag-2:
    backgroundColor: "{colors.tag-carmine}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.tag}"
  lane-tag-1:
    backgroundColor: "{colors.tag-ochre}"
    textColor: "{colors.ink}"
    rounded: "{rounded.tag}"
  lane-tag-0:
    backgroundColor: "{colors.tag-green}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.tag}"
  copy-line:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "46px"
  case-tag:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    padding: "63px 24px 24px"
    width: "28rem"
  case-strip-1-attached:
    backgroundColor: "{colors.tag-ochre}"
    textColor: "{colors.ink}"
    padding: "12px 24px"
    height: "76px"
  case-strip-2-torn:
    backgroundColor: "{colors.carmine-tint}"
    textColor: "{colors.carmine-ink}"
    padding: "12px 24px"
    height: "76px"
  station-marker-done:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.form-paper}"
    rounded: "{rounded.pill}"
    size: "40px"
  station-marker-now:
    backgroundColor: "{colors.form-paper}"
    textColor: "{colors.scrub-teal}"
    rounded: "{rounded.pill}"
    size: "40px"
---

# Design System: gittifacts

## Overview

**Creative North Star: "The Triage Board"**

Every change arrives tagged like a triage case. The visual world borrows the grammar of emergency triage and ward observation charts, not their costume: a tag that pairs a printed color band with a numeral and a word, a banded chart that shows which observation forced the escalation, and a handover of what is still uncertain. Lanes are triage levels. Unknown escalates, exactly as it does on a ward.

The ground is cool form paper under ink-navy text, quiet enough to read for three minutes on a phone in daylight. Color is reserved for three jobs: the one action ink (scrub teal) on the primary action, focus and selection; the triage bands on lane tags and their tints; and verdict and state (proven, unproven, risk). Everything else is ink, hairline and space. Density is Operate density on lists and Read comfort inside the tour: 65 to 70 characters of prose, real code excerpts, real numbers.

Agents are first-class actors in this world, not credentials. They appear where the work is (the dashboard's agent band, bylines as squares beside people's circles), and every command a person can run has its agent twin one keystroke away: the palette prints the MCP call and CLI command that do the same thing, and names the acts a product rule keeps human instead of pretending an agent could do them. The boundary between a person's hand and an agent's is shown, never implied.

Chrome that floats over the chart is acetate: the clear sleeve a ward clips over its observation chart. You can still see the chart through it, faintly, so you never lose your place; everything you read or sign sits on paper.

Dark mode is composed for the on-call reviewer at night: a deep navy-black ground, lighter surfaces for elevation, desaturated bands, a brighter teal, and slightly wider tracking and leading for light-on-dark text.

The marketing landing is a Persuade surface inside this world, not a second brand. It loads the app's tokens, base, components and triage styles unchanged and adds only a page type scale, a page layout and three landing components: the lane tag set at poster scale as a case tag, the station strip turned into a vertical spine, and a copy line for values a reader will paste. Product screens appear as themselves, at 1:1.

**Key Characteristics:**
- Die-cut lane tags with a punched hole, numeral and word: never color alone.
- Banded observation chart (lane columns tinted, hairline armature) explains every lane.
- Three verdict shapes: filled disc with check, dashed ring, triangle.
- One family (Atkinson Hyperlegible Next) for all UI; its Mono sibling only for code, hashes and data.
- Hairline-separated rows instead of cards; panels only where a block is one decision.
- Acetate chrome (top bar, station strip, bottom bars, palette) over a paper chart; never acetate under text you read or a form you sign.
- Every command has an agent twin or a stated human-only rule (the palette's two hands).
- On the landing, the same world at poster scale: a case tag whose signed evidence tears off the review it proves.

## Colors

A restrained cool-neutral ground, one action ink, and a printed triage set that only ever means lane, verdict or state.

### Primary
- **Scrub Teal** (`scrub-teal`): the primary action (Approve, Sign and approve, Sign in, Create agent), links, the current station marker in the tour strip and on the landing's station spine, copy buttons, focus rings (as `focus-teal`) and text selection (tint). Counts, status chips, secondary actions and "awaiting" states are ink, not teal.

### Secondary
- **Tag Carmine** (`tag-carmine`, ink `carmine-ink`, tint `carmine-tint`): Lane 2, risk verdicts, failing checks, breaches, the kill switch, broken signatures. Printed flat, never glowing.
- **Tag Ochre** (`tag-ochre`, edge `ochre-edge`, ink `ochre-ink`, tint `ochre-tint`): Lane 1, unproven verdicts and "not measured" states. The band always carries the darker edge so its shape reads against paper. The reviewer's handover and plan risk declarations are deliberately not ochre: they sit on neutral surfaces so ochre never doubles as "uncertain prose".
- **Tag Green** (`tag-green`, ink `green-ink`, tint `green-tint`): Lane 0, proven verdicts, passed tests, verified signatures and chains.

### Neutral
- **Form Paper** (`form-paper`): the page ground.
- **Sheet** (`sheet`): raised surfaces: panels that hold a decision, inputs, chips, the decision bar.
- **Panel / Panel Strong** (`panel`, `panel-strong`): the second neutral layer for the sidebar, code blocks, empty and loading states, segmented tracks.
- **Hairline / Hairline Strong** (`hairline`, `hairline-strong`): row dividers and container edges.
- **Ink 1 to 4** (`ink`, `ink-2`, `ink-3`, `ink-4`): primary text, secondary text, tertiary text and metadata (all at least 4.5:1 on paper), and control boundaries (`ink-4`, 3.4:1 on paper).
- **Night set** (`night`, `night-sheet`, `night-panel`, `night-ink`, `night-teal`): the dark theme's ground, surfaces, text and action ink.

### Named Rules
**The Band Means Lane Rule.** Carmine, ochre and green appear only as lane, verdict or state, and always beside a numeral, word or shape that says the same thing.

**The One Ink Rule.** Teal marks the primary action, links, the current selection and focus. If a count, a status or a secondary button is teal, it is wrong.

**The Unknown Is Not Green Rule.** A skipped or failed measurement renders in ochre or carmine with the words "Not measured" or "Measurement failed", never in green and never hidden.

## Typography

**Body Font:** Atkinson Hyperlegible Next (variable 200 to 800, self-hosted), fallback ui-sans-serif, system-ui.
**Code Font:** Atkinson Hyperlegible Mono (variable, self-hosted), fallback ui-monospace, SF Mono, Menlo.

**Character:** a typeface designed by the Braille Institute for legibility at a glance. Its distinct I, l and 1 and its slashed zero are kept on purpose: 0/O and l/1 confusion is a real hazard when reading hashes, versions and code on a phone.

### Hierarchy
- **Display** (720, 1.75rem, 1.25): screen titles at desktop widths.
- **Headline** (720, 1.4375rem, 1.25): screen titles on phones; rollout state lines.
- **Title** (720, 1.1875rem, 1.3): section, stop, lane-group and panel titles.
- **Reading** (400, 1.0625rem, 1.6): tour stop reasons, plan intent. Measure capped at 68ch.
- **Body** (400, 1rem, 1.55): default text and inputs (never below 16px in inputs).
- **Label** (560, 0.875rem, 1.2): buttons in dense spots, chips, secondary lines.
- **Meta** (400, 0.75rem, 1.45): timestamps, counts, fine print. Floor for functional text.
- **Code** (400, 0.8125rem mono, 1.6): diffs, signatures, hashes, globs, versions, commands.

### Named Rules
**The Mono Is Data Rule.** Monospace is for code, hashes, versions, globs and commands. Names, ids in prose, labels and numbers in UI use the UI face with tabular numerals.

**The Sentence Case Rule.** No tracked all-caps labels and no kicker above a heading. Headings speak for themselves; metadata sits below them.

### Landing scale (Persuade surface)
The landing keeps the one family and steps above the app's ramp at a ratio of about 1.25, in fixed steps per breakpoint rather than fluid clamps. Token values are the phone steps.
- **Landing Display** (`landing-display`): 2.625rem on phones, 3.75rem from 640px, 4rem from 1024px, 4.75rem from 1280px. The hero headline and the closing title only; the close answers the hero at the same scale.
- **Landing Headline** (`landing-headline`): 1.75rem, 2.125rem from 640px, 2.5rem from 1024px, at a 22ch measure. Section heads.
- **Landing Lede** (`landing-lede`): 1.1875rem, 1.25rem from 640px, 1.375rem from 1024px, in ink-2 at a 40ch measure (36ch in the hero). The one line under a section head.
- **Title and body:** the app's Title, stepping to 1.3125rem from 1024px, for the case title, step headings and measured figures; the app's Reading style in ink-2 at a 62ch measure for body copy.
- **In-between steps** for the tag and the spine: rows and copy lines 0.9375rem; station leads, strip titles and rule titles 1.125rem; station names 1.375rem, 1.625rem from 1024px (760); the wordmark 1.25rem (760); strip numerals 2.625rem (800, tabular).

The display line is set as a typographic object, not left to wrap: each sentence takes two lines, broken after its verb (subject and verb, then object: "Humans approve / intent. / Machines prove / conformance."), every line its own block with balanced wrapping, so the two sentences read as a parallel pair at 390px and at 1440px.

## Layout

Mobile-first on a 4px spacing scale (4, 8, 12, 16, 24, 32, 48, 64). Page gutter is 16px on phones, 24px from 640px, 32px from 1024px. Content tops out at 960px, or 1240px for dense screens.

From 1024px a 248px sidebar holds navigation, repository shortcuts with review counts, the theme switch and the demo-data note, and a slim 48px acetate top bar sits inside the content column: empty and see-through at rest, it fades in with the crumbs and the page title once the large title scrolls away (`--topbar-h` names its height for anything sticky beneath it). Below 1024px the sticky 56px top bar shows the back target (or wordmark) and fades the page title in the same way, with a menu drawer for the same destinations. While the session is checked on first load the frame (sidebar or top bar, with the wordmark) is already drawn and only the content area waits. Two-column screens (plan, evidence, rollout, agents, repo) switch at 1000 to 1100px to a reading column plus a sticky rail (roughly 360 to 392px) that holds the decision or context. The walkthrough switches by its own width instead, because the sidebar takes 248px of the viewport: its 360px rail joins once the tour is 1040px wide (about 1350px of window), so the reading column never drops under 640px; below that it keeps the phone layout (lane block inline, decision in the bottom bar, at most 720px wide). The reviewer's handover splits into two columns only when it is itself 600px wide (a container query). Every single-column grid uses `minmax(0, 1fr)` so wide code never scrolls the page; code scrolls inside its own box with line numbers pinned.

Primary actions on phones sit in a fixed bottom bar in the thumb zone with safe-area padding. Rows are separated by hairlines; spacing groups first, containers second.

### Landing page
Same gutters and 4px scale. Content tops out at 80rem (1280px) inside the gutters, wider than the app's reading widths because the page carries product screens at 1:1. Each section opens with a head (headline, then lede, 16px apart, 48px above the content), and sections are spaced by one section step: 72px on phones, 96px from 640px, 128px from 1024px.

Three panel bands open, break and close the page: the hero band (panel ground, hairline below), the agents band (panel, hairlines above and below, one section step above it) and the close band (panel, hairline above), with the footer on panel under a strong hairline. Everything between them sits on form paper and is organized by hairlines and 2px ink rules, not cards.

From 64em the hero splits into the text and a 28rem tag column, 64px apart, and each loop station into a 48px marker column, a 25rem text column and its artifact, with 48px gaps. These switches are written in em so the page stays stacked when a reader enlarges text. Comparison tables, step lists and the agents band turn to two columns at 1024px; the rules list goes to two columns at 768px and three at 1024px.

## Elevation & Depth

Flat and tonal on the page; one material above it. Depth on the page comes from the surface ladder (paper, sheet, panel) and hairlines. Above the page sits acetate, the only translucent material, worn only by chrome that floats over a scrolling chart. Shadows are few and each means something (below). Dark mode uses lighter surfaces, not shadows, for elevation on the page.

### Acetate (the one material)
Tokens in `tokens.css`: `--acetate` (canvas at 64%) for chrome at the top, `--acetate-strong` (surface at 76%) for chrome at the bottom and the palette, `--acetate-filter` (`blur(18px) saturate(1.6)`: the saturation lets lane bands and teal links bleed colour through, which is what reads as glass), `--acetate-rim` (two 1px inner edges: a lit top, white at 60% by day and 7% at night, and a defined bottom, rule-strong at 40%) and `--acetate-edge` (rule-strong at 70%). Text on acetate keeps 4.5:1 over busy content (code, lane tags) in both themes; the blur and the ground do that work, never a darker text colour.

Worn by exactly these surfaces, and listed in `packages/web/test/design-rules.test.ts` (`ACETATE_SURFACES`), which fails the build for any other:
- **Top bar** (`.topbar`), at every width: part of the page at rest (no edge); gains its edge, rim and float shadow once the chart scrolls under it (`data-scrolled`, 200ms). Phones and tablets: 56px with back, title, search and menu. From 1024px: 48px inside the content column, invisible at rest and fading in with the crumbs, the title and search once the page head has scrolled away.
- **Station strip** (`.stations`): sticky under the top bar.
- **Decision bar** (`.tour__bar`), **plan bar** (`.plan-bar`), **switch-off bar** (`.kill-bar`): fixed in the thumb zone on phones.
- **Palette** (`.palette`): a sheet lifted over the page.

Scrims (`::backdrop`) may blur up to 4px so the page recedes behind a dialog; nothing else blurs. The palette's scrim is the full `--backdrop` with the 4px blur, so the sheet separates from the page it floats over.

**The Acetate Rule.** Acetate is chrome over a chart, never a reading or signing surface. Prose, code, the triage chart, tables, cards and forms sit on paper. When a bottom bar opens a form (a review comment), it turns solid (`.tour__bar:has(.is-open)`). Under `prefers-reduced-transparency`, `prefers-contrast: more` or without `backdrop-filter`, acetate becomes the solid ground it sits on. To add a surface: add it here, to `ACETATE_SURFACES`, and to DECISIONS.md, in that order.

### Shadow Vocabulary
- **Raise** (`0 1px 2px ink/6%, 0 4px 14px ink/6%`): selected segment, current nav item, decision and signing panels.
- **Sheet** (`0 -6px 28px ink/14%`): the fixed decision bar, the plan signing bar and the switch-off bar on phones; the nav drawer.
- **Float** (`--shadow-float`, `0 6px 18px -12px ink/35%`): under the top bar once the chart scrolls beneath it. A fall-off below an edge, never a halo.
- **Lift** (`--shadow-lift`, `0 24px 64px -24px ink/45%`): the palette, the one sheet lifted over the whole page.
- **Tag lift** (landing only; `drop-shadow(0 1px 1px ink/10%) drop-shadow(0 10px 22px ink/10%)`, at night `drop-shadow(0 12px 28px black/45%)`): the case tag, the one object lifted off the hero band. A drop shadow, so it follows the die-cut silhouette rather than a box.
- **Eyelet** (landing only; `inset 0 2px 3px ink/30%`): falls inside the case tag's punched hole, so the hole reads as punched rather than printed.

### Named Rules
**The Edge Or Lift Rule.** A container has a hairline edge or a raise, not a hairline plus a wide shadow. The one exception is a decision panel, which carries a stronger 2px ink edge because it is where a signature happens.

## Shapes

Small, functional radii: tick marks 2px, tags and inline code 3px, chips and agent avatars 6px, controls 8px, panels and code blocks 12px, sheets 18px, and fully round pills only for count badges. Circles mean people (avatars) and stops (station numbers); squares mean agents and the platform. Integrations (apps a person installed: deploy platforms, check runners) are plates: their logo or monogram on the 3px tag radius, ringed by a hairline held 2px off the edge, so an installed app never reads as an agent. The lane tag is the one custom silhouette: a rectangle with a chamfered left end and a punched hole, drawn as an SVG path with an even-odd hole so it reads on any ground.

On the landing the same silhouette turns portrait at poster scale as the case tag: both top corners chamfered (2.25rem), a hole (9px radius) punched through at center 30px from the top and ringed by a 5px panel-strong eyelet. Tear-off strips hang below it; a strip's perforation is a 2px dashed rule between 6px punched notches, and a torn strip trades the perforation for a toothed torn edge (10px teeth).

## Motion

Motion explains state, place and consequence; it never decorates. Subtle by default: short distances (6 to 8px, a 1.5% scale), decelerating curves, exits faster than entrances. One focal moment per surface: the approval seal in the app, the torn strip on the landing.

### Tokens (all in `tokens.css`)
- **Curves:** `--ease-out` (routine state), `--ease-expo` (`cubic-bezier(0.16, 1, 0.3, 1)`, arrivals that settle: views, sheets, the palette), `--ease-in` (exits).
- **Routine durations:** `--dur-feedback` 120ms (hover, press, selection), `--dur-state` 200ms (a state change), `--dur-exit` 180ms (leaving), `--dur-view` 280ms (arriving on a screen, the palette), `--dur-sheet` 320ms (a sheet rising).
- **Authored moments, each named:** `--dur-fill` 640ms (a meter fills once on arrival), `--dur-signed` 700ms (the decision settles into its signed ground), `--dur-seal-ring` 520ms and `--dur-seal-check` 320ms, `--dur-trace` 2400ms (one lap of a working agent's trace), `--dur-spin` 900ms, `--dur-shimmer` 1400ms, and on the landing `--dur-case-mark` 420ms and `--dur-case-tear` 1100ms.

### Vocabulary
- **Arriving on a screen:** the heading settles 6px (`view-rise`) and the content fades in 40ms later (`view-fade`). Only the head moves: a transform on the content would capture the fixed bars inside it.
- **Chrome reacting to scroll:** the top bar's edge and float shadow fade in (`--dur-state`).
- **Sheets and dialogs:** the drawer slides 24px in from the edge and back out; the palette drops 6px and grows from 98.5%; the decision sheet rises 16px. Scrims fade. Exits use `--dur-exit` and `--ease-in`.
- **Measures:** meters fill by `transform: scaleX` once, on arrival (`@starting-style`), and move by transform when the value changes. Never width.
- **Disclosures:** `details` open and close by height where the browser can animate to `auto` (`interpolate-size`), and snap elsewhere.
- **Feedback:** a pressed button moves 1px; hover and selection change colour in `--dur-feedback`.
- **After the decision:** the seal draws (60ms + 520ms ring, check to 780ms), then the next change rises 8px in at 820ms, so the seal stays the moment.
- **Live work:** a working agent's row carries a soft trace along its hairline (`fleet-trace`), the app's one live signal. It runs only while the row is on screen.

### Named Rules
**The Token Time Rule.** Every transition and animation is timed by a `--dur-*` token; a literal may only be a delay inside a choreography or `0s`. Endless loops exist only for loading feedback (`spin`, `shimmer`) and the agent trace (`fleet-trace`). `design-rules.test.ts` fails the build otherwise.

**The Reduced Motion Rule.** Under `prefers-reduced-motion: reduce`, travel goes and state stays: `base.css` clamps every animation to an instant and keeps colour and opacity transitions at 80ms, the seal appears drawn, the trace, view rise and next-up rise do not run, and smooth scrolling becomes a jump. New motion that moves things goes inside `@media (prefers-reduced-motion: no-preference)`.

## Components

### Buttons
- **Shape:** gently rounded (8px), 44px tall by default, 36px for dense desktop actions (44px on coarse pointers).
- **Primary:** scrub teal with sheet text. One per decision.
- **Secondary:** sheet with an ink-4 boundary; panel on hover.
- **Quiet:** teal text on transparent; teal tint on hover.
- **Danger / Danger outline:** carmine for irreversible actions (reject, kill, revoke) only after an inline confirmation names the action.
- **States:** pressed nudges down 1px; busy swaps the icon for a spinner and the label for the operation ("Signing approval…"); disabled drops to 55% opacity.
- **Landing call to action:** the same primary button at 52px with 1.0625rem bold text and 32px side padding, once in the hero and once in the close; the top bar's Sign in stays secondary.

### Lane Tag (signature)
The die-cut tag at 31×18, 37×22 or 47×28. Lane 2 carmine with sheet numeral, Lane 1 ochre with ink numeral and darker edge, Lane 0 green with sheet numeral, shadow mode as a dashed green outline on green tint, unrouted as a dashed ink-4 outline with an en dash. Always labelled for assistive tech ("Lane 1, glance, shadow mode").

### Observation Chart (signature)
"Why this lane": rows of signals, three tinted lane columns, hairline armature. Each row's marker sits in the column of the minimum lane it forces: small ink dot for non-deciding signals, a 16px lane-colored disc for the deciding ones, a dashed ochre ring for anything not measured. A 2px ink rule separates the computed result; a dashed rule and an arrow show shadow mode raising the route.

### Verdict Marks
Proven is a filled green disc with a check; unproven a dashed ochre ring with a dash; risk a carmine triangle with an exclamation. Always paired with the word. The tour's station numbers echo them: green outline, dashed ochre, filled carmine.

### Station Strip
Sticky under the top bar, on acetate: "Stop 2 of 5" and a line of verdict marks (44px targets, shrinking toward 36px only when a long walkthrough needs the room); the current station gets a teal underline and a larger mark. The current stop is the last one whose top has passed a reading line near the top of the view (30% of the height, at most 280px), so a stop whose tail still shows above the next is not current; jumping to a stop (a station, J/K, Resume) keeps it current until you scroll again. "Stop N of M" never leaves the strip; when you return to a tour you left mid-way, "Resume at stop N" (a neutral pill, 44px on coarse pointers) sits after the line, under it on phones. A jump (J/K, a station, Resume) focuses the stop's heading and is announced; scrolling is not. The stop in view owns attention: the other stops recede through colour steps that stay AA (titles to ink-2, station numbers to a neutral outline, chip and code borders to hairline). Verdict marks and words never fade.

### Chips
- **Status chip:** icon plus label on a tone tint (6px radius, 24px tall).
- **Evidence chip:** sheet with hairline edge, kind icon, label and a tone-colored value; links to the evidence item.

### Term
Day-one vocabulary is Plan, Change and review lane. Every other word a new person meets (calibrating, evidence, walkthrough, attestation, policy, scopes, mission control, attempts…) is a Term where it first appears on a screen: the word in its own ink with a dotted ink-4 underline (never teal: it is not an action), a button whose accessible description is the one-line hint, and on tap a paper card (sheet, strong hairline, the float fall-off, 8px radius, up to 288px) with the hint and a teal "More about …" link to the docs page. The card is a popover under the word, kept inside the viewport, and closes on scroll, Escape or a tap elsewhere. Hints live in `lib/terms.ts` and follow the docs glossary.

**The Show It When It Matters Rule.** Advanced chrome appears when it is relevant, never removed: Mission control only when agents have open Changes in the repo, the auto-merge agreement only while a repo is calibrating, raw scope ids only beside their words.

### Inputs / Fields
Visible labels above, 44px minimum, 16px text, ink-4 boundary; 2px teal focus ring with 1px offset; carmine boundary and an inline message below on error.

### Navigation
Sidebar links are 40px rows. Exactly one link is current (`aria-current="page"`): the most specific place you are in. On a repository, its queue or members, and on a change or plan of that repository, that is the repository's link (a raised sheet, like any current item), and Dashboard drops to a quiet ancestor (ink text, no raise, no teal). Agents use the bot icon (they are actors, not keys). Under the wordmark a "Search or act" field with its ⌘K hint opens the palette; on phones a search button sits beside the menu in the top bar. The phone drawer repeats the sidebar (one component renders both): the search field, the places, the repositories with their review counts, and the theme switch, at 44px, and slides out as well as in. The aside is the "Navigation" landmark; `main` is the only "main". The theme switch and the palette's two hands are radio groups: one Tab stop, arrows move the choice.

On the landing, a sticky 64px top bar on the page ground with a hairline below holds the wordmark, the section anchors (ink-2, 44px targets, panel on hover) from 900px, and a secondary Sign in. Below 900px the anchors sit behind a disclosure menu that needs no script, in a raised sheet.

### Diff Excerpt
A bordered code block (12px radius) with a sheet header (path in mono with the directory dimmed and file name bold, cited line range, file status). A pinned gutter shows the old and the new line number side by side, so a reviewer can cite either; on phones it shows one (the side the line lives on) and screen readers hear one ("line 18", "old line 19"). Code wider than the box fades out at the right edge into the code ground, and a "Wrap" toggle in the header folds long lines with a hanging indent. Additions and deletions carry +/− signs and green or carmine tints; cited lines are stronger; uncited context is dimmed; gaps say how many lines are skipped. Syntax-light: comments, strings, numbers and keywords only.

### Screenshot Pair
Before, after and a computed difference, registered at one scale (frames 250px wide on phones, three 200px columns from 640px). On phones a Before / After / Difference segmented control swaps frames in place, which is itself the registered comparison. The difference frame fades the "after" capture to grey and marks changed pixels in carmine, computed in the browser from the two captures.

### Decision Sheet (walkthrough)
The same panel in the rail (a paper panel with the 2px ink edge, see the Edge Or Lift Rule) and in the phone bar. Choosing opens the sheet with focus on its title for Approve (the comment is optional; on a phone a focused field would raise the keyboard over the sheet) and in the comment for Request changes and Reject, where one is required. Back, Escape and (on phones) a tap on the page close it and return focus to the choice; the signed outcome takes focus so it is read before Next up. On phones the open sheet is a modal moment: the page behind it dims under a `--backdrop` tint (no blur: the blur allowance is for a dialog's `::backdrop`) and goes inert, and Back in the thumb zone is the one way out. Below 480px "Request changes" reads "Changes" (spoken in full) so Approve keeps the widest target.

When the author is an agent the viewer owns, the panel says so with the plan's note ("Your agent … wrote this change. You are allowed to approve it, but a teammate's eyes are the stronger check."): the boundary is shown, not enforced. Under the rail's choices one meta line says what the author does after the choice under the pointer or focus. The lane picker is one Tab stop with arrow keys; "No call" is the unset state, quiet text at the end, never teal. A person who may close the change (its author, the author agent's owner, a maintainer) finds a quiet "Close change…" under the context links; it opens an inline confirmation that names the act before the danger button appears (the agent twin is `close_change`).

### Approval Seal
The app's focal motion moment. When the server confirms an approval, a ring and check draw themselves (`--dur-seal-ring` then `--dur-seal-check`, ease-out) on a panel that settles into the green tint. Reduced motion shows the finished seal without drawing. The landing has one moment of its own, on the case tag.

**Next up.** After any decision the panel offers the next change waiting in the same repo (never one the viewer wrote) as a row with its small lane tag, its title on up to two lines, its author (agents as squares) and how many wait, or says nothing else waits; after an approval it adds "Watch it land in the merge queue". It rises in once the seal has drawn.

### Palette (agent twins)
One palette for going, acting and delegating: ⌘K or Ctrl+K anywhere, `/` outside a text field, or the "Search or act" field in the sidebar and the search button in the phone top bar. Acetate sheet, 640px wide, 12vh from the top on desktop and under the safe area on phones. Commands come from the screen in view (`lib/commands.ts`): this change, plan or repo first, then places, then preferences. Typing also searches the objects the product is about: open changes and plans in your repositories (by title or id) and your agents, fetched once per opening from the lists the dashboard and repo screens already use; a pasted id or app URL jumps straight there. Each object row's twin reads it (`get_change_status`, `get_plan`). While typing, groups keep their headings and the group with the best match comes first. Not found screens offer the palette, filled with what the address asked for.

Two hands, as a radio pair under the query: **Myself** runs the command (Enter); **An agent** copies its twin, the MCP call (Enter) or the CLI command (Shift+Enter), shown in mono in a pane under the list with copy buttons. Cmd/Ctrl+Enter hands any command off without switching (key hints use ⌘ on Apple devices and Ctrl elsewhere). Alt+A flips the hand from the query field. The mode is remembered. A row that can't go the way you asked (Enter on a person-only row in agent mode, Cmd/Ctrl+Enter on a row with no twin) does nothing but say why in the status line.

**The Twin Rule.** Every command carries exactly one of three: an agent twin (an MCP tool and its arguments that the server's contract accepts); a `personOnly` reason naming the product rule that keeps it human (approving or rejecting a plan or change, requesting changes, the switch-off, policy such as auto-merge, membership, creating or revoking agents, freezing the queue); or a `twinless` reason saying why no agent call fits (navigation only, such as the next stop or a theme, or no tool yet, named as such). In agent mode person-only rows stay listed with a lock and "Only a person", and twinless places with "No agent tool" and their reason, so the boundary is visible, never hidden (a reader's own controls, the theme and the walkthrough keys, stay out of agent mode). Agent-only commands (re-run CI, wait until it merges, ask for a review, close a change, draft a plan, start a change) appear only in agent mode. `test/commands.test.ts` checks every twin against `packages/mcp/tools.introspection.d.ts`: the tool exists, every argument is one it takes, every required argument is given.

### Keyboard
Single keys act on the screen in view and never fire while typing, with a modifier held, or under an open dialog. No key signs anything: A opens the decision, it never approves. Each key and its palette row run the same handler (`state/keys.ts`, `gf:command`), so they cannot drift.
- Anywhere: ⌘K / Ctrl+K, `/` (palette).
- Walkthrough: J next stop, K previous stop, A open the decision, E evidence. Escape closes the decision sheet (as Back does) and focus returns to the choice that opened it.
- After a decision: N opens the next change waiting in the repo (the one Next up shows).

### Agent Mark
Every agent square in the app is one component (`components/AgentMark.tsx`), so an agent has one face on every screen. The glyph is the first letter plus the agent's number when its name ends in one ("F12", "F07", "P02"; a lone digit is padded, "P01", so no mark reads as a severity code), else the initials of two words ("QA"). A stable variant from the principal id sets the ground (solid ink or a 1.5px ink outline) and the corner (square or notched at the top right), so two agents with the same name still differ. Ink, paper and shape only, never a hue (the Band Means Lane Rule); 6px radius; tabular numerals.

### Agent Band (dashboard)
"Agents at work", above the repositories when one waits on a person, below them otherwise: each agent with an audit event this week in repositories the viewer can see, theirs or a colleague's, read from the signed audit log (`lib/fleet.ts`). A row is the agent's mark, the agent and its accountable person ("your agent" for the viewer's own), its last act with its object ("Plan drafted **Dunning emails for failed card payments**", then "in billing-api" and its age), and its state in words: **Needs review** / **Plan needs approval** (its next move is a person's; ink, a teal person icon), **Failing** (carmine, a state), **Working** (an event in the last 15 minutes; the trace), **Quiet** (muted). Ordered by that state, then recency; the row opens what the agent acted on, and its focus ring is drawn inside the row (the row clips the trace). Its link says "Manage agents" when every row is the viewer's and "All agents" otherwise. It never says "waits on you": the viewer may not be an eligible reviewer. Loading keeps its place: the dashboard holds one skeleton shaped like itself (the band's head and as many rows as it had last time, then the repository rows) until the checklist, the band and the list have all answered, so nothing jumps. Errors and a quiet week stay silent: the band adds to the dashboard, it never blocks it.

### Agents Page
Each agent's home. A row carries the band's state word and last act (the same `fleetFrom` read), what it may do and the repositories it can touch as links, when it was created, last active and ends, a quiet **Trail** link to `/audit?actor=<id>`, and **Revoke…** as a secondary button that turns danger only inside the inline confirmation. The confirmation and the result say what really stops: the API and MCP refuse the agent at once, a push token it already holds works for up to an hour, and its open changes stay open (listed with links after the revoke). Other people's agents active in the viewer's repositories are listed read-only under their own heading. The rail leads with **Connect an agent** (the MCP URL and the CLI login as copy lines); the hand-made token form (name, repositories, scopes, an end date) sits behind "Add one by hand…".

### Audit Log
Events name their subject by title and repository (the raw `kind:id` stays as a tooltip) and agents carry their accountable person. Filters are plain fields, Who (grouped people, agents, platform), Action and Subject, kept in the URL as `?actor=&action=&subject=`; the who and a search mark beside each subject filter on click. On phones a row is two lines (what happened to what; who, when, `#seq` and the hash as a trailing chevron) and the filters fold into one line that says what is applied. A verified chain is a one-line banner that opens to explain; a broken one is the full warning, always open.

### Switch-off Bar (rollout, phones)
Below 1100px, a fixed acetate bar carries the current error rate, the rate that reverts ("0.42% errors · reverts at 1.4%") and a danger-outline "Switch off…" that opens the same form as the side column (scrolled into view, reason focused). It steps aside (slides down, `--dur-exit`) while the Switch off section itself is on screen above the bar (a sliver behind the bar doesn't count, or a section that peeks at the fold would hide the bar before its button shows): one control at a time. The plan's signing bar (`.plan-bar`, "Review and sign") does the same while the signing panel is on screen, and its jump puts focus on the attestation checkbox.

### Case Tag (landing signature)
One change at poster scale: the lane tag's die-cut read as a case record, on a sheet ground (the strongest night panel in dark mode), up to 28rem wide, with the hole and eyelet at the top (see Shapes). Inside: the repository, a "Demo data" chip and the change id in mono; the change title; the authoring agent with its square avatar; then evidence rows under a 2px ink rule, separated by hairlines. Each row is a label (ink-3) and a value with its verdict mark at the end. A row that holds the lane up takes its lane's tint and ends in the small lane tag instead of a verdict mark. Below 480px each label sits above its value. A meta-size signature line names the key and the git ref.

Tear-off strips hang under the body, one per lane the change started out owing. Each pairs a 2.625rem numeral with the lane word and its status ("Glance: still owed", "Full review: torn off").

**The Torn Strip Rule.** A strip still attached is review still owed, printed in its lane's full band with the band's edge on its perforation. A strip the evidence tore off drops to its lane's tint behind a torn edge and hangs rotated 3 to 4 degrees below the tag. The loudest thing on the tag is always what a person still has to do.

Motion plays where it is seen (an IntersectionObserver in `landing/client.ts`, no hydration): when the tag comes into view the verdict marks settle in row by row (420ms ease-out each, from 55% scale and transparent, starting at 260ms, 90ms apart); once the torn strip itself is in view and the marks have settled, it comes away: it starts attached, gives once and falls to its hanging angle (1100ms, `cubic-bezier(0.16, 1, 0.3, 1)`). Without script, and under reduced motion, the tag shows settled with the strip already torn, with no movement.

### Station Spine (landing)
The tour's station strip turned vertical, as one change's progress through numbered stations. A 2px ink-4 spine runs behind circular markers (40px, 48px from 64em) in the rollout track's vocabulary: a done station is a filled ink disc with a paper numeral; the station the change is at now is a paper disc with a teal ring and teal numeral, haloed by a teal-tint ring, and its name carries a teal-tint "Now at …" chip (6px radius). Each station has a name, a one-line lead, body copy, an optional measured figure above a hairline (title size, tabular), and its artifact. On phones the artifact takes the full column and the spine passes behind it.

### Copy Line (landing)
A value a reader will paste: the URL or command in mono at 0.9375rem in a sheet field with an ink-4 boundary (8px radius, 46px tall), and a 44px teal copy button behind a hairline divider. The value is real, selectable text first. The button stays hidden until script finds the clipboard; it confirms with a small ink "Copied" bubble and a polite announcement, and when copying fails it says to select the text. Commands keep one line from 640px and scroll inside their box; on phones they wrap. An inline copy button (44px target, teal icon) does the same for a value inside a sentence.

### Product Screens (landing)
Screens from the product appear without browser or device chrome, at 1:1: each capture is made at the width it is shown (736px in the desktop station column, 358px on a 390px phone) and served at 1x and 2x, with a light and a dark capture and, for wide screens, a phone-width crop below 640px. The dark sources follow the theme forced in the footer switch, not only the system setting. Phone-width tour screens sit in an 18px-radius hairline frame, two side by side from 640px and one on phones. Demo data is labeled where it is seen.

## Do's and Don'ts

### Do:
- **Do** pair every lane, verdict and test outcome with a word, numeral or shape (the Band Means Lane Rule).
- **Do** keep tour prose at 1.0625rem with a 68ch measure, and put the reviewer agent's least-confident and not-done lists before the stops on a neutral surface with a 3px ink top rule.
- **Do** make signing deliberate: name the consequence, gate on an explicit attestation where the act is a plan approval, wait for the server, and say what was recorded.
- **Do** use tabular numerals for counts, percentages, times and line numbers.
- **Do** keep primary phone actions in the bottom bar with `env(safe-area-inset-bottom)` padding.
- **Do** show product screens on the landing at 1:1 with light, dark and phone-width captures, and label demo data where it is seen.
- **Do** make every landing copy control work without script: the value is selectable text first, the copy button an enhancement.
- **Do** give every new command an agent twin or a person-only rule (the Twin Rule), and add it to the palette when it gets a screen.
- **Do** time motion with tokens and let reduced motion keep the state change (the Token Time and Reduced Motion Rules).
- **Do** keep agents visible as actors where the work is: squares with a name and an accountable person, and what they did last.

### Don't:
- **Don't** encode a lane as a colored side stripe on a card or row; use the tag and the tinted group band.
- **Don't** use monospace for names, labels or prose ids.
- **Don't** put a kicker or tracked uppercase label above a heading.
- **Don't** show a pulsing live dot; live data is shown as a ticking countdown or a "checked N seconds ago" line, and live agent work as the trace.
- **Don't** put acetate under text you read or a form you sign, or blur anything that isn't a listed surface or a scrim (the Acetate Rule).
- **Don't** offer an agent twin for an act a product rule keeps human, and don't hide those acts from the agent view either.
- **Don't** let anything but code blocks and rails scroll horizontally.
- **Don't** animate for decoration: motion answers what changed, where you are or what happens next (Motion, Vocabulary). One focal moment per surface: the approval seal in the app, the torn strip on the landing.
