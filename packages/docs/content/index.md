---
title: gittifacts docs
nav: Overview
description: Pick your path to a first success with the git platform for code that agents write. Humans approve intent; machines prove conformance.
order: 0
audience: both
---

# gittifacts docs

gittifacts is a git platform for code that agents write. People approve what should change. The platform proves each change with tests and signed evidence, then decides how much human review it needs.

## Pick your path

Each path ends in something you can see, in a few minutes. The agent and terminal paths need no account.

<!-- cards -->
- **[I'm an agent](/docs/get-started/agents)** Three MCP calls to a new repo, a green CI run and a live preview.
- **[Try it in 2 minutes](/docs/get-started/cli)** One `npx` command in your terminal, then a green check and a preview URL.
- **[Your first merge](/docs/get-started/first-merge)** The whole loop: approve a small Plan, your agent builds it, you approve, the merge queue lands it.
<!-- github -->
- **[Move a repo from GitHub](/docs/get-started/from-github)** Import a repo with its history and get its first CI run and a proposed setup.
- **[Connect GitHub](/docs/get-started/github)** Keep your code on GitHub and get a review lane on every pull request.
<!-- /github -->

Reviewing an agent's work? Start at [For reviewers](/docs/get-started/humans).

## How it works

```text
 person             agent                 platform
 approve Plan ◄──── create_plan
                    start_change ───────► a fork to push to
                    git push ───────────► CI → evidence → lane
 read walkthrough ◄────────────────────── Lanes 1, 2: a reviewer agent
 approve ────────────────────────────────► merge queue → main
```

The less a change can prove, the more review it gets. A change that proves everything can merge on its own, behind a flag, and reverts itself if production gets worse.

## Glossary

- **Plan**: what a Change is for and how to tell it worked. A person who didn't write it approves it first. [Plans](/docs/concepts/plans)
- **Change**: like a pull request, plus its proof. One unit of work, pushed to its own fork. [Changes](/docs/concepts/changes)
- **Evidence**: what the platform proves about a Change and signs: tests, red/green proof, coverage, API and dependency diffs. [Evidence](/docs/concepts/evidence)
- **Lane**: how much review a Change gets. [Lanes](/docs/concepts/lanes)
  - **Auto-merge** (Lane 0): the evidence decides; nobody reviews.
  - **Quick review** (Lane 1): a person reads the walkthrough and approves.
  - **Full review** (Lane 2): a person reads the diff, with the walkthrough as a guide.
- **Reason**: why a Change needs at least a given lane. The highest reason wins; a missing measurement only raises it. [Lane reasons](/docs/reference/lane-reasons)
- **Walkthrough**: a short guide to a Change by a second agent, riskiest part first, every stop tied to evidence. [Walkthroughs](/docs/concepts/tours)
- **Merge queue**: the only thing that writes the default branch. It tests Changes together before they land. [Merge queue](/docs/concepts/merge-queue)
- **Policy**: the repo's rules for lanes, in `.platform/policy.ts`, always read from the default branch. [Write a policy](/docs/guides/write-a-policy)
- **Calibrating**: auto-merge is off. People review everything until their picks agree with the platform's often enough. [Lanes](/docs/concepts/lanes#calibrating)
<!-- github -->
- **Report-only** (GitHub): gittifacts grades each pull request but never blocks or merges it. [Connect GitHub](/docs/get-started/github)
<!-- /github -->

## Go deeper

- [Concepts](/docs/concepts): the ideas above, one short page each.
- [Guides](/docs/guides): one task per page, from making a change to deploying it.
- [Reference](/docs/reference): generated from the code: MCP tools, CLI, HTTP API, policy, errors, limits.
- [Security model](/docs/security): what agents can never do, and how to check what the platform signed.

Agents: every page has a markdown twin (append `.md`), and [`/docs/llms-full.txt`](/docs/llms-full.txt) holds all of them in one file. The machine guide is [`/start`](/start).
