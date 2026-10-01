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
---

# Design System: gittifacts

## Overview

**Creative North Star: "The Triage Board"**

Every change arrives tagged like a triage case. The visual world borrows the grammar of emergency triage and ward observation charts, not their costume: a tag that pairs a printed color band with a numeral and a word, a banded chart that shows which observation forced the escalation, and a handover of what is still uncertain. Lanes are triage levels. Unknown escalates, exactly as it does on a ward.

The ground is cool form paper under ink-navy text, quiet enough to read for three minutes on a phone in daylight. Color is reserved for three jobs: the one action ink (scrub teal) on the primary action, focus and selection; the triage bands on lane tags and their tints; and verdict and state (proven, unproven, risk). Everything else is ink, hairline and space. Density is Operate density on lists and Read comfort inside the tour: 65 to 70 characters of prose, real code excerpts, real numbers.

Dark mode is composed for the on-call reviewer at night: a deep navy-black ground, lighter surfaces for elevation, desaturated bands, a brighter teal, and slightly wider tracking and leading for light-on-dark text.

**Key Characteristics:**
- Die-cut lane tags with a punched hole, numeral and word: never color alone.
- Banded observation chart (lane columns tinted, hairline armature) explains every lane.
- Three verdict shapes: filled disc with check, dashed ring, triangle.
- One family (Atkinson Hyperlegible Next) for all UI; its Mono sibling only for code, hashes and data.
- Hairline-separated rows instead of cards; panels only where a block is one decision.

## Colors

A restrained cool-neutral ground, one action ink, and a printed triage set that only ever means lane, verdict or state.

### Primary
- **Scrub Teal** (`scrub-teal`): the primary action (Approve, Sign and approve, Sign in, Create agent), links, the current station marker in the tour strip, focus rings (as `focus-teal`) and text selection (tint). Counts, status chips, secondary actions and "awaiting" states are ink, not teal.

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

## Layout

Mobile-first on a 4px spacing scale (4, 8, 12, 16, 24, 32, 48, 64). Page gutter is 16px on phones, 24px from 640px, 32px from 1024px. Content tops out at 960px, or 1240px for dense screens.

From 1024px a 248px sidebar holds navigation, repository shortcuts with review counts, the theme switch and the demo-data note; below that, a sticky 56px top bar shows the back target (or wordmark) and fades the page title in only once the large title scrolls away, with a menu drawer for the same destinations. Two-column screens (tour, plan, evidence, rollout, agents, repo) switch at 1000 to 1100px to a reading column plus a sticky rail (roughly 360 to 392px) that holds the decision or context. Every single-column grid uses `minmax(0, 1fr)` so wide code never scrolls the page; code scrolls inside its own box with line numbers pinned.

Primary actions on phones sit in a fixed bottom bar in the thumb zone with safe-area padding. Rows are separated by hairlines; spacing groups first, containers second.

## Elevation & Depth

Mostly flat and tonal. Depth comes from the surface ladder (paper, sheet, panel) and hairlines. Two soft shadows exist and both mean something: a raise for the selected segment, the active nav item and decision panels, and a sheet shadow for anything fixed to the bottom of the screen. Dark mode uses lighter surfaces, not shadows, for elevation.

### Shadow Vocabulary
- **Raise** (`0 1px 2px ink/6%, 0 4px 14px ink/6%`): selected segment, current nav item, decision and signing panels.
- **Sheet** (`0 -6px 28px ink/14%`): the fixed decision bar and the plan signing bar on phones; the nav drawer.

### Named Rules
**The Edge Or Lift Rule.** A container has a hairline edge or a raise, not a hairline plus a wide shadow. The one exception is a decision panel, which carries a stronger 2px ink edge because it is where a signature happens.

## Shapes

Small, functional radii: tick marks 2px, tags and inline code 3px, chips and agent avatars 6px, controls 8px, panels and code blocks 12px, sheets 18px, and fully round pills only for count badges. Circles mean people (avatars) and stops (station numbers); squares mean agents and the platform. The lane tag is the one custom silhouette: a rectangle with a chamfered left end and a punched hole, drawn as an SVG path with an even-odd hole so it reads on any ground.

## Components

### Buttons
- **Shape:** gently rounded (8px), 44px tall by default, 36px for dense desktop actions (44px on coarse pointers).
- **Primary:** scrub teal with sheet text. One per decision.
- **Secondary:** sheet with an ink-4 boundary; panel on hover.
- **Quiet:** teal text on transparent; teal tint on hover.
- **Danger / Danger outline:** carmine for irreversible actions (reject, kill, revoke) only after an inline confirmation names the action.
- **States:** pressed nudges down 1px; busy swaps the icon for a spinner and the label for the operation ("Signing approval…"); disabled drops to 55% opacity.

### Lane Tag (signature)
The die-cut tag at 31×18, 37×22 or 47×28. Lane 2 carmine with sheet numeral, Lane 1 ochre with ink numeral and darker edge, Lane 0 green with sheet numeral, shadow mode as a dashed green outline on green tint, unrouted as a dashed ink-4 outline with an en dash. Always labelled for assistive tech ("Lane 1, glance, shadow mode").

### Observation Chart (signature)
"Why this lane": rows of signals, three tinted lane columns, hairline armature. Each row's marker sits in the column of the minimum lane it forces: small ink dot for non-deciding signals, a 16px lane-colored disc for the deciding ones, a dashed ochre ring for anything not measured. A 2px ink rule separates the computed result; a dashed rule and an arrow show shadow mode raising the route.

### Verdict Marks
Proven is a filled green disc with a check; unproven a dashed ochre ring with a dash; risk a carmine triangle with an exclamation. Always paired with the word. The tour's station numbers echo them: green outline, dashed ochre, filled carmine.

### Station Strip
Sticky under the top bar: "Stop 2 of 5" and a line of verdict marks; the current station gets a teal underline and a larger mark. Offers "Resume at stop N" (a neutral pill) when you return to a tour you left mid-way. The stop in view owns attention: the other stops recede through colour steps that stay AA (titles to ink-2, station numbers to a neutral outline, chip and code borders to hairline). Verdict marks and words never fade.

### Chips
- **Status chip:** icon plus label on a tone tint (6px radius, 24px tall).
- **Evidence chip:** sheet with hairline edge, kind icon, label and a tone-colored value; links to the evidence item.

### Inputs / Fields
Visible labels above, 44px minimum, 16px text, ink-4 boundary; 2px teal focus ring with 1px offset; carmine boundary and an inline message below on error.

### Navigation
Sidebar links are 40px rows; the current one is a raised sheet with a teal icon. The phone drawer repeats the same list at 44px.

### Diff Excerpt
A bordered code block (12px radius) with a sheet header (path in mono with the directory dimmed and file name bold, cited line range, file status). A pinned gutter shows the old and the new line number side by side, so a reviewer can cite either. Additions and deletions carry +/− signs and green or carmine tints; cited lines are stronger; uncited context is dimmed; gaps say how many lines are skipped. Syntax-light: comments, strings, numbers and keywords only.

### Screenshot Pair
Before, after and a computed difference, registered at one scale (frames 250px wide on phones, three 200px columns from 640px). On phones a Before / After / Difference segmented control swaps frames in place, which is itself the registered comparison. The difference frame fades the "after" capture to grey and marks changed pixels in carmine, computed in the browser from the two captures.

### Approval Seal
The system's one authored motion moment. When the server confirms an approval, a ring and check draw themselves (520ms then 320ms, ease-out) on a panel that settles into the green tint. Reduced motion shows the finished seal without drawing.

## Do's and Don'ts

### Do:
- **Do** pair every lane, verdict and test outcome with a word, numeral or shape (the Band Means Lane Rule).
- **Do** keep tour prose at 1.0625rem with a 68ch measure, and put the reviewer agent's least-confident and not-done lists before the stops on a neutral surface with a 3px ink top rule.
- **Do** make signing deliberate: name the consequence, gate on an explicit attestation where the act is a plan approval, wait for the server, and say what was recorded.
- **Do** use tabular numerals for counts, percentages, times and line numbers.
- **Do** keep primary phone actions in the bottom bar with `env(safe-area-inset-bottom)` padding.

### Don't:
- **Don't** encode a lane as a colored side stripe on a card or row; use the tag and the tinted group band.
- **Don't** use monospace for names, labels or prose ids.
- **Don't** put a kicker or tracked uppercase label above a heading.
- **Don't** show a pulsing live dot; live data is shown as a ticking countdown or a "checked N seconds ago" line.
- **Don't** let anything but code blocks and rails scroll horizontally.
- **Don't** spend motion anywhere except state feedback and the approval seal.
