---
version: 1
slug: "src-landing-landing-tsx"
primary_target: "src/landing/Landing.tsx"
related_targets: ["landing.html","src/landing"]
---

# Surface brief: marketing landing page (`/` for signed-out visitors)

Scope: the prerendered landing page served at `/` to humans without a session. Agents asking `/`
for JSON or markdown keep getting the machine guide; signed-in humans get the app.
Visitor mode: **Persuade**.
Audience: senior engineers and tech leads who run coding agents and own outcomes they did not type.
Arrives from a link or a colleague; reads on a 1440px desk screen or a 390px phone.
Job: understand the rule (humans approve intent, machines prove conformance) in one viewport,
believe it from real artifacts, then sign in or point an agent at `/start`.
Proof on hand: measured live numbers (time-to-first-green 36-48 s; push to signed evidence about
50 s; tour about $0.015 per change; EU jurisdiction; Ed25519 evidence in git-notes) and real
product screenshots with demo data (labeled). No customers, no invented benchmarks.
Constraints: inherits the review app's world (DESIGN.md) unchanged; static HTML at build time,
near-zero JS (copy, theme), HTML+CSS under 60 KB gzip, light and dark, WCAG 2.2 AA, 390 and 1440.
Build path: code-led (no harness image tool; the API fallback would bill the user's key).

## Direction round (unattended)

Surface scope inside the established triage world. Seven grounded structures, by resonance:
1 one change through the loop (station strip as the page spine); 2 three lanes as the page's
columns; 3 evidence ledger document; 4 the page as a reviewer tour (stops, verdicts, least
confident); 5 human and agent split screen; 6 time-to-first-green run log; 7 the tag at poster
scale (a case record with tear-off lane strips). Seed 2bd96dd3 dealt 7 (lead), 2, 4. No answer
channel existed in this subagent session, so the lead proceeds unattended (no decision page).

Challenger verdicts (world fixed, so only system discipline transfers):
- Game Boy four-shade field: declined. Kept: total palette commitment, no colour outside tokens.
- Ray Gun layout desk: declined. Kept: the hero headline is set as a typographic object.
- Teletext service: declined. Kept: every loop station has a stable address (#plan, #evidence).
- ANSI BBS nightboard: declined (terminal costume). Kept nothing.
- Kiln glaze shelf: declined. Kept nothing.
- Orizuru fold sequence: declined as world. Kept: one uncut sheet carries every earlier crease:
  one change (billing-api, chg_fx2r7) is carried through every station.

## Direction contract

THESIS: A change is a triage case, and the page hands you its tag. Every change starts owing a
full review; signed evidence tears off what it proves; whatever is unknown stays attached.
Refuses the dev-tool hero (screenshot in a browser frame beside a headline) and feature grids.

OWN-WORLD: DESIGN.md unchanged: cool form paper, ink navy, one scrub teal for actions, triage
bands only as lane or verdict beside a numeral or word. The die-cut tag silhouette with a
punched hole, verdict marks, the station strip and hairline rows. Atkinson Next at poster size.

STORY: Read the rule; see one change's tag with its evidence and its torn strip; follow the same
change through plan, change, evidence, lane, tour, queue, rollout; learn the agent path (one URL,
three calls, measured first green); check the rules the platform refuses to bend; sign in or
copy the agent line.

FIRST VIEWPORT: nav (mark, anchors, Sign in). Left: the rule set large in two sentences, one
sub line, primary teal "Sign in" and a copyable "Point your agent at <host>/start" line. Right
(below on phones): a portrait tag at poster scale, hole punched at top, case record rows with
verdict marks, a Lane 1 strip still attached and the Lane 2 strip torn away. One authored load
moment: marks settle, then the Lane 2 strip tears. Reduced motion shows the final state.

FORM: candidate 7 of 7 (tag at poster scale), seed key 2bd96dd3, fused with candidate 1's spine.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the
verdict, DESIGN.md, and every shipping raster carrying its provenance
