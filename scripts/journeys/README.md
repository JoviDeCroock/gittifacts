# Journey videos

Scripts that record every user journey against the **live** platform, for review. Browser journeys
are Playwright scripts; agent (terminal) journeys run the real commands, capture their output with
timestamps, and replay it in xterm.js. Nothing here is part of the product or the pnpm workspace.

## Set up once

```sh
cd scripts/journeys && npm install --no-package-lock   # playwright, outside the workspace
npx playwright install chromium ffmpeg                 # skip if ~/Library/Caches/ms-playwright has them
```

Credentials stay outside the repo (a scratch directory):

- `cookies.txt`: a signed-in human's session (Netscape jar from `curl -c`), for signed-in journeys.
- `agent.json`: `{ "token": "gtf_…" }`, an agent token of that human (Agents → Create agent and token).
- `state.json`: ids the journeys act on. The agent-side scripts fill most of it; add by hand
  `human: { email, password }` (desktop claim), `newHuman: { name, email, password }` (phone
  sign-up), `claimUrlMobile` (a second unclaimed project: `POST /api/v1/projects` with no
  credentials), `lane0ChangeId` / `revertedChangeId` / `trainsProjectId` (an M4 run: `scripts/e2e/m4.ts`).

## Record

Run from the repo root, one browser at a time. `OUT` is where the videos go.

```sh
J=scripts/journeys; T="pnpm exec tsx"
# Agent journeys: capture (real commands, real time), then replay into a video.
$T $J/terminal/10-cli-onboarding.ts --out $OUT --state $OUT/state.json     # anonymous; leaves claimUrl
$T $J/terminal/11-mcp-agent.ts --out $OUT --state $OUT/state.json --agent-file agent.json
$T $J/terminal/12-import-github.ts --out $OUT --state $OUT/state.json --agent-file agent.json
for c in $OUT/casts/*.json; do $T $J/replay.ts $c --out $OUT; done

# Agent side of the human journeys (off camera): a Plan, its Change, three queue Changes.
$T $J/setup.ts plan --state $OUT/state.json --agent-file agent.json        # before journey 3
$T $J/setup.ts implement --state $OUT/state.json --agent-file agent.json   # after 3, before 4
$T $J/setup.ts queue --state $OUT/state.json --agent-file agent.json       # before 6 (queue2: a second round)
$T $J/setup.ts lane2 [a|b|c] --state $OUT/state.json --agent-file agent.json  # a planless Lane 2 Change for 04 --mobile

# Browser journeys (add --mobile for 390×844 where the journey has a phone variant: 01, 02, 04).
$T $J/record.ts 01-first-visit --out $OUT
$T $J/record.ts 02-claim --out $OUT --state $OUT/state.json                # headed (Turnstile)
$T $J/record.ts 03-plan-approval --out $OUT --state $OUT/state.json --cookie-jar cookies.txt
# … 04 to 09 the same way; then:
$T $J/build-index.ts --out $OUT     # journeys.json from <slug>.json + findings.json
```

## How it works

- `lib/recorder.ts`: CDP screencast frames → Playwright's bundled ffmpeg (mjpeg in, VP8 webm out) at a
  constant frame rate. It can pause, so dead waits are cut; the overlay then shows "⏩ N s".
- `lib/overlay.ts`: cursor (a finger dot on phones), click ripples, chapter captions, and the real
  elapsed time in the corner (it keeps counting through cuts, so real durations stay visible).
- `lib/journey.ts`: the browser journey runner (title card, goto/click/scroll/type, `cut()`,
  `snap()` for review screenshots, console errors and HTTP ≥ 400 collected with video timestamps).
- `lib/term.ts` + `terminal/replay.html`: the terminal capture and its replay. Gaps over 2 s play as 1 s
  with a marker; tokens are redacted before anything is stored (`gtf_…`, `"token": …`, `Bearer …`).
- Turnstile refuses a headless browser and any browser whose locale or user agent is overridden, so
  the claim journey runs headed with neither.
- Videos are webm (VP8). Keep each under 12 MB. Phone videos record at 2×; if one runs over, re-encode it
  with the same ffmpeg: `ffmpeg-mac -i in.webm -c:v vp8 -b:v 650k -crf 14 -an out.webm` (the bundled build
  decodes and encodes VP8 but has no trim, concat or text filters, which is why cuts happen while recording).
- Journeys 3, 4, 6 change live state (approve a Plan, approve Changes, merge through the queue): each take needs
  fresh agent work from `setup.ts`. Journeys 5 and 7 read an M4 run's Changes and change nothing.
- `build-index.ts` merges each `<slug>.json` (chapters, measured numbers, console/HTTP problems, cuts) with the
  hand-written review in `findings.json` into `journeys.json`.
