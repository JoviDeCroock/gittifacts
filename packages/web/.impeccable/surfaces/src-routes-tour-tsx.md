---
version: 1
slug: "src-routes-tour-tsx"
primary_target: "src/routes/tour.tsx"
related_targets: ["src/routes"]
---

# Surface brief: review app (tour, change list, plan, evidence, rollout, audit, agents)

Scope: the whole `@app/web` review app; the tour is the first and focal surface.
Visitor mode: **Operate** shell; the tour body is **Read** inside it.
Audience: tech leads supervising agent fleets. Phone triage between meetings (390px, one hand,
daylight); deep review at a desk (1440px).
Job: decide a change from its tour in under three minutes, trusting each claim because it cites
signed evidence. Approve plans deliberately. Watch rollouts and pull the kill switch fast.
Constraints: Preact + signals, hand-written CSS, OKLCH tokens, light + dark, WCAG 2.2 AA, 44px
targets, color never the only signal, mock backend for demo data (synthetic, labeled).
Build path: code-led (no harness image tool; the API fallback would bill the user's key).

## Direction round (unattended)

Seven grounded candidates, by resonance: aviation dispatch release + checklists; engineering
drawing title blocks + change orders; transit line diagrams; triage tags + observation charts;
notarial registry ledgers; referee reports; highway lane-control signage (the literal reading).
Assigned by roll: triage tags + observation charts (seed 4dd7f07b). No answer channel existed in
this subagent session, so the assigned direction proceeds unattended (decision page not served).

Challenger verdicts:
- midnight transit diagram: competitive (audience identification holds; dark enamel ground fails
  the daylight scene). Kept: focus the chosen corridor, never shrink the network to a miniature.
- botanical folio: declined. Kept: registered comparison at one fixed scale and ground.
- streaming card wall: declined. Kept: the focused item owns attention; the rest recedes.
- variable-font specimen: declined. Kept: hierarchy from scale and weight on a strict baseline.
- Emigre bitmap specimen: declined. Kept: honest state toggles (rendered vs raw signed payload).
- Crouwel grid specimen: declined. Kept: the grid is visible armature where it carries data.

## Direction contract

THESIS: Every change arrives tagged like a triage case: a lane tag, a banded observation chart
that shows exactly which signal forced the lane, and a handover of what is uncertain. Refuses the
category default: a dark diff viewer, mono everywhere, a green merge button at the end of a scroll.

OWN-WORLD: Cool form-paper ground, deep ink-navy text, one scrub-teal action ink used only for
the primary action, focus and selection. Lane tags are die-cut tag shapes with a punched hole and
a flat printed band (carmine, ochre, green; dashed outline for shadow), always numeral plus word.
Banded chart grids with hairline rules. Verdicts in three shapes: filled disc with check (proven),
open dashed ring (unproven), triangle (risk). Atkinson Hyperlegible Next for all UI; its Mono
sibling only for code, hashes and diff line numbers.
Raises: [transit] the current stop owns the viewport while a station strip keeps the route;
[folio] before/after shots registered at one scale; [streaming] off-focus stops recede;
[specimen] scale+weight hierarchy on a 4px baseline; [bitmap] "view signed payload" raw toggle;
[Crouwel] chart grid as visible structure.

STORY: The reviewer sees why this change sits in its lane, reads the handover of what the
reviewer agent is least sure of, walks the stops in order, opens evidence where a claim matters,
and decides from the thumb zone. Approval is a named, signed act.

FIRST VIEWPORT: 390px tour: compact sticky header (back, title, "Stop 2 of 6"), station strip
of verdict marks under it; then title, author (agent vs human), lane tag with "Why lane 1"
chart summary; the handover begins above the fold's end. Sticky bottom bar: Reject, Request
changes, Approve tour (teal, widest, right thumb). 1440px: nav rail, reading column of stops,
sticky right column with the lane chart and the decision panel.

Adaptations (cited): the change title moves into the sticky top bar once the large title scrolls
away, and "Stop n of N" lives in the sticky station strip directly under it (no duplicated title in
the first viewport); on desktop the decision panel leads the rail so all three actions stay above
the fold at 1440x900 (finish review, round 1).

FORM: triage tags + observation chart, candidate 4 of 7 on my ordered list, seed key 4dd7f07b.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Open decisions
- Real lane colors for tenants with color-vision needs are covered by numeral+word; no per-user
  palette switch is planned.
