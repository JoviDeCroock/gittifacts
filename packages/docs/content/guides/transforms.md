---
title: Reproducible transforms
nav: Reproducible transforms
description: Declare a codemod once; later Changes that it reproduces byte for byte get those hunks verified and hidden from human review.
order: 19
audience: both
group: Daily work
---

# Reproducible transforms

A large mechanical change (a rename, a generated client, a formatter run) shouldn't cost a reviewer an afternoon. Put the codemod in `.platform/transforms/`; when a Change's hunks are exactly what that script produces from the base commit, the platform marks them verified and folds them into one tour stop.

## How verification works

```text
for each script in .platform/transforms/ on the BASE commit:
  run it on a clean checkout of BASE  ──►  tree'
  compare tree' with the Change's HEAD by blob id
  every file the script rewrote matches HEAD  ──►  transform: verified (those hunks hidden)
```

- The script is taken from the **base** commit, never the Change's head. A codemod added in the same Change it claims to reproduce proves nothing.
- Scripts run as `.mjs`, `.js`, `.cjs` (node), `.ts` (node with type stripping) or `.sh` (sh). They get the head's `node_modules` only when the dependency graph is identical.
- A file the script rewrites but that still has its base content in the Change counts as a mismatch. A script whose output appears nowhere in the head is `skipped`.

## 1. Add the transform (once)

Write a deterministic script that edits files in the current directory:

```ts
// .platform/transforms/rename-format-money.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (path.endsWith(".ts")) {
      const before = readFileSync(path, "utf8");
      const after = before.replaceAll("formatMoney", "formatCurrency");
      if (after !== before) writeFileSync(path, after);
    }
  }
}
walk("src");
```

Ship it in its own Change. It touches `.platform/**`, so it is Lane 2 and a human approves it:

```text
start_change({ repoId: "3fk2q8wz7m1x0c5v9nbd", title: "Transform: rename formatMoney", category: "chore" })
```

## 2. Use it in a later Change

Once the script is on the default branch, run it on your checkout, commit the result alone, and declare the category:

```sh
node .platform/transforms/rename-format-money.mjs
git add -A && git commit -m "Rename formatMoney to formatCurrency (transform)"
```

```text
start_change({ repoId: "3fk2q8wz7m1x0c5v9nbd", title: "Rename formatMoney to formatCurrency", category: "transform" })
```

Push to the fork. Expected in `get_evidence`: an item with `kind: "transform"` and `status: "ok"`, and in the diff each reproduced file has `transformVerified: true`. The tour collapses those hunks into one stop.

## 3. Reach Lane 0 with it

Verified transform hunks don't count against the reviewer, but the Change still has to pass every Lane-0 gate. To let pure transform Changes reach Lane 0 without a Plan, add `"verified-transform"` to `planlessLane0` in the [policy](/docs/guides/write-a-policy).

Keep manual edits in a separate Change: anything the script didn't produce is reviewed normally.
