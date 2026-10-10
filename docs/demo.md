# A 10-minute demo

A script for showing gittifacts end to end, ordered by the questions Cloudflare's
["We want you to build the next Git platform"](https://blog.cloudflare.com/next-git-platform-on-cloudflare/)
post asks (2026-10-01): how agents coordinate, what happens when their changes conflict, how their
work gets reviewed, and how to record why a change was made. Its minimum bar is several agents
working on changes concurrently; part 2 is that. Timings are measured, from `STATUS.md`.

Before recording: a deployed platform (`docs/deploy.md`), a signed-in human who is a reviewer on a
repo, and that repo's id. Every command below prints what it did; nothing needs editing on camera.

## 0. The rule (30 s)

> Humans approve intent. Machines prove conformance.

One sentence, then the three lanes: **Auto-merge** (Lane 0), **Quick review** (Lane 1), **Full
review** (Lane 2). The lane is computed from signed evidence and can only go up.

## 1. An agent arrives with nothing (1 min)

Point an agent at `https://<host>/start` (or run the CLI) and let it call `create_project` with no
credentials:

```sh
npx -y https://<host>/cli/gittifacts.tgz --host https://<host> init --template workers-api --name demo --clone
```

Show: an Artifacts repo, a fork, CI in a container, a green check and a preview URL in under a
minute (36–57 s measured live). The repo is unclaimed until a human claims it.

## 2. Many agents, one repo, at the same time (3 min)

```sh
GITTIFACTS_EMAIL=… GITTIFACTS_PASSWORD=… pnpm tsx scripts/e2e/many-agents.ts \
  --url https://<host> --repo <repoId> --agents 6
```

What happens, line by line in the timeline it prints:

- The human registers six agent principals, each with its own token and owner.
- All six start a Change at once. **A Change is a fork**: `start_change` forks the repo in
  Artifacts and hands back a push token scoped to that fork, valid for at most an hour. There are no shared
  branches to race on, and no agent can push to main.
- Each push fires an Artifacts `cf.artifacts.repo.pushed` event into a Workflow, which grades that
  head: CI, signed evidence (red/green, coverage, mutation, public API diff), a lane, and a
  walkthrough written by a reviewer agent that is not the author.
- Each agent enqueues its Change. Open `/repos/<repoId>/queue` beside the terminal: independent
  Changes take parallel tracks, and batches are speculated on top of each other.

Proof it isn't staged: `apps/platform/test/integration/many-agents.test.ts` runs the same journey
through the real Worker, Durable Objects and Workflows on every deploy gate.

## 3. Conflicts are resolved in the queue, not by the author (1.5 min)

Agents 1 and 2 rewrote the same README line. Whichever lands second conflicts: the queue hands it
to the resolver agent (`system:resolver`), which writes a verified patch. The timeline shows
`resolving_conflict → resolution_ready`. A resolution that adds lines of its own invalidates the
human approval and goes back to review. Main is never red: every tree it points at passed CI.

Scale, from the simulator (`sim/merge-queue/report.md`, the real queue core on a seeded world): on
its gate-200 workload (about 600 Changes) the queue lands 167 per hour with a median of 13 minutes
in the queue. A strictly serial queue manages 5.7 per hour on the same workload.

## 4. Review costs what the risk is worth (1.5 min)

Open one of the Changes. Show the lane and its reasons, the evidence, and the walkthrough's stops
ordered by risk. Try to approve with an agent token: refused, always (`403`). Approve as the
human. On GitHub, the same grading runs report-only on pull requests (one check run and one
summary comment).

## 5. Why a change was made, from a plain clone (1 min)

```sh
git fetch origin 'refs/notes/*:refs/notes/*'
git log --notes=why --notes=evidence -3
```

Every commit the queue landed carries two signed notes: `refs/notes/evidence` (what it was proven
to do) and `refs/notes/why` (the approved plan's intent and acceptance criteria, the agent that
wrote it and the human accountable for it, the lane, the approvals). No platform needed to read
them; the platform's published keys verify them.

## 6. Easy to undo after merge (1.5 min)

A merged Change rolls out behind its own flag. Measured live (`scripts/e2e/m4.ts`): a Change that
throws for 40% of traffic is detected 23.9 s after its first error, its flag is off 0.1 s later,
and a verified pure revert opens 6.8 s after detection and auto-merges.

## What Artifacts does in this design

| Primitive | Used for |
|---|---|
| Namespace with an EU jurisdiction | every repo, fork and scratch repo |
| `fork()` | one fork per Change, one scratch repo per merge-queue batch, reverts |
| Repo-scoped tokens with TTLs | push grants (≤ 1 h), CI and preview reads (≤ 15 min), main writes (≤ 5 min) |
| `cf.artifacts.repo.pushed` → Workflow trigger | grading starts on push, no polling |
| `refs/notes/*` over git | signed evidence and why notes travel with every clone |
| `import()` | bring a public repo in |
