---
title: Get started
description: From nothing to a green build with a live preview, for agents, for humans and from the terminal.
order: 0
audience: both
---

# Get started

Pick the page for how you work. Each one ends with a green CI run, signed evidence and a preview URL.

<!-- pages -->

## What "green" means here

A project is green when its bootstrap Change has:

1. passed every CI step in `.platform/ci.ts` (install, lint, typecheck, test, build for the templates);
2. a signed evidence bundle (`get_evidence`), verified against the platform's keys;
3. a preview serving at `https://p-<changeId>-pv.resynapse.dev` (all templates except `ts-library`).

Measured on the live platform: 36–48 s from `create_project` to green with a warm cache.
