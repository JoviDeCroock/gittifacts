# Conflict corpus (resolver eval)

Small TypeScript repositories that conflict, for the merge queue's resolver agent
(`@app/resolver`). Each case is a base tree, one or more upstream Changes (already on main), the
Change being rebased, and the **expected-behaviour tests** a correct resolution must pass.

Like `fixtures/`, these are not workspace packages and are never installed: tests run with the
monorepo's vitest through a `node_modules` symlink.

## Layout

```
fixtures/conflicts/<case>/
  case.json      kind, plans, expectations (validated by packages/resolver/scripts/lib/corpus.ts)
  base/          the whole base tree (a default package.json is added when absent)
  upstream/ …    overlay(s) for the upstream Change(s), one commit each on main, in case.json order
  change/        overlay for the Change being rebased (a branch from base)
  checks/        test files added to the resolved tree; they must all pass
  resolved/      the known-correct final content of every file the resolution writes
                 (used to script the model in `pnpm test`; deletions are in case.json)
```

`case.json`:

```jsonc
{
  "name": "modify-delete-moved",
  "kind": "textual",                    // textual: merge-attempt conflicts; semantic: it merges
                                        // cleanly and the merged tree's tests fail
  "description": "…",
  "change":   { "changeId", "title", "dir": "change", "plan": { "title", "intent", "acceptanceCriteria", "scopePaths"? }, "delete"? },
  "upstream": [{ "changeId", "title", "dir": "upstream", "plan": { … }, "delete"? }],
  "expect": {
    "conflicted": ["src/legacy.ts"],    // what merge-attempt must report (textual)
    "outsideHunks": true,               // a correct resolution edits outside the conflict hunks
    "culprit": null,                    // semantic: the upstream changeId to blame
    "delete": ["src/legacy.ts"]         // files the correct resolution deletes
  }
}
```

## Cases

| Case | Kind | What makes it hard | Outside hunks |
|---|---|---|---|
| `handler-registry` | textual | two regions (definition + registry entry), keep both handlers | no |
| `import-merge` | textual | one import line must name both helpers; two appended functions | no |
| `signature-and-body` | textual | new parameter + rewritten body: one combined return line | no |
| `rename-vs-edit` | textual | the resolved loop must call upstream's renamed helper | no |
| `switch-cases` | textual | union member + switch case on both sides (two regions) | no |
| `config-defaults` | textual | both add a key; upstream also changes the neighbouring default | no |
| `modify-delete-moved` | textual | upstream deleted the file and moved the function; the fix must be ported to the new file | **yes** |
| `two-files-and-tests` | textual | source and test file both conflict | no |
| `add-add` | textual | both sides created the same file (no common base) | no |
| `extract-vs-fix` | textual | upstream extracted validate(); the stricter check must land in it too | no |
| `package-json-scripts` | textual | JSON: both touch the comma on the same line; result must parse | no |
| `semantic-renamed-field` | semantic | upstream renamed `User.name`; new code reads the old field (two upstream candidates) | yes |
| `semantic-default-changed` | semantic | upstream changed slugify's default separator; fix the new caller, not upstream | yes |
| `semantic-options-object` | semantic | positional argument silently ignored after upstream's options object | yes |

## Checking and running

```sh
pnpm --filter @app/resolver exec tsx scripts/check-corpus.ts [case…]   # corpus integrity
pnpm --filter @app/resolver test                                        # pipeline, scripted model
CF_ACCOUNT_ID=… AI_GATEWAY_ID=… AI_GATEWAY_TOKEN=… pnpm --filter @app/resolver eval   # real model
```

`check-corpus` asserts, per case: the tests pass at base, after each upstream Change and on the
Change alone; merge-attempt reports the expected status and conflicted paths (semantic cases: the
merged tree fails); the expected resolution passes the checks with the expected scope and culprit;
and naive resolutions (only upstream's side, only the Change's side, or no fix for a semantic
conflict) **fail** the checks, so passing them means something.
