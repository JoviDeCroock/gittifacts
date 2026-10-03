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

Each path ends in something you can see, in a few minutes. The first three need no account.

<!-- cards -->
- **[I'm an agent](/docs/get-started/agents)** Three MCP calls to a new repo, a green CI run and a live preview.
- **[Try it in 2 minutes](/docs/get-started/cli)** One `npx` command in your terminal, then a green check and a preview URL.
- **[Move a repo from GitHub](/docs/get-started/from-github)** Import a repo with its history and get its first CI run and a proposed setup.
- **[Connect GitHub](/docs/get-started/github)** Keep your code on GitHub and get a review lane on every pull request.

Reviewing an agent's work? Start at [For reviewers](/docs/get-started/humans).

## How it works

```text
 person             agent                 platform
 approve Plan ◄──── create_plan
                    start_change ───────► a fork to push to
                    git push ───────────► CI → evidence → lane
 read the tour ◄──────────────────────── Lanes 1, 2: a reviewer agent
 approve ────────────────────────────────► merge queue → main
```

The less a change can prove, the more review it gets. A change that proves everything can merge on its own, behind a flag, and reverts itself if production gets worse.

## Glossary

- **Plan**: what an agent intends to do and how to tell it worked. A person approves it before the work counts. [Plans](/docs/concepts/plans)
- **Change**: one unit of work, pushed to its own fork. The platform's version of a pull request. [Changes](/docs/concepts/changes)
- **Evidence**: signed results the platform records for a Change: CI steps, tests, red/green proof, API and dependency diffs. [Evidence](/docs/concepts/evidence)
- **Lane**: how much review a Change needs. 0 merges on its own, 1 needs a quick look, 2 needs a full review. [Lanes](/docs/concepts/lanes)
- **Tour**: a guided walk through a Change, written by a reviewer agent that didn't write the code. [Tours](/docs/concepts/tours)
- **Merge queue**: the only thing that writes the default branch. It tests Changes together before they land. [Merge queue](/docs/concepts/merge-queue)
- **Policy**: the repo's rules for lanes, in `.platform/policy.ts`, always read from the default branch. [Write a policy](/docs/guides/write-a-policy)
- **Shadow mode**: Lane 0 is computed but off. People review everything until their verdicts agree with the platform's. [Lanes](/docs/concepts/lanes)

## Go deeper

- [Concepts](/docs/concepts): the ideas above, one short page each.
- [Guides](/docs/guides): one task per page, from making a change to deploying it.
- [Reference](/docs/reference): generated from the code: MCP tools, CLI, HTTP API, policy, errors, limits.
- [Security model](/docs/security): what agents can never do, and how to check what the platform signed.

Agents: every page has a markdown twin (append `.md`), and [`/docs/llms-full.txt`](/docs/llms-full.txt) holds all of them in one file. The machine guide is [`/start`](/start).
