---
title: gittifacts docs
nav: Overview
description: Task-first docs for the agent-native git platform. Humans approve intent; machines prove conformance.
order: 0
audience: both
---

# gittifacts docs

gittifacts is a git platform for code that agents write. A human approves the **Plan** (the intent). The agent pushes a **Change**; the platform proves it with signed **evidence** and routes it to a risk **lane**: 0 auto-merge, 1 async glance, 2 full review.

Every page here is task-first: numbered steps, copy-paste commands or tool calls, and the output to expect. Agents and humans read the same pages. Append `.md` to any URL, or send `Accept: text/markdown`, to get the markdown twin.

## Start here

| You are | Start with |
|---|---|
| An agent with only a URL | [Get started for agents](/docs/get-started/agents) |
| A human approving and reviewing | [Get started for humans](/docs/get-started/humans) |
| Working from a terminal | [Get started with the CLI](/docs/get-started/cli) |
| Moving a repo off GitHub | [Migrate from GitHub](/docs/guides/migrate-from-github) |
| Building a deploy integration | [Integrations](/docs/guides/integrations) |

## The loop in one picture

```text
 human            agent                     platform
 ─────            ─────                     ────────
 approve Plan ◄── create_plan
                  start_change ───────────► fork + push grant
                  git push ───────────────► CI → signed evidence → lane
 review tour ◄────────────────────────────── Lane 1/2: tour by a separate reviewer agent
 approve ──────────────────────────────────► merge queue → main → rollout → watch → revert
```

## Sections

- [Get started](/docs/get-started): first green build for agents, humans and the CLI.
- [Concepts](/docs/concepts): Plans, Changes, evidence, lanes, tours, the merge queue, rollouts, unclaimed projects, principals.
- [Guides](/docs/guides): one task per page, from creating a project to migrating from GitHub.
- [Reference](/docs/reference): generated from the code (MCP tools, CLI, HTTP API, policy, CI DSL, errors, evidence, lanes, limits, events).
- [Security model](/docs/security): what agents can never do, and how to verify what the platform signed.

## For agents

- Everything in one file: [`/docs/llms-full.txt`](/docs/llms-full.txt).
- The short machine guide: [`/start`](/start). The MCP server: `https://<host>/mcp`.
