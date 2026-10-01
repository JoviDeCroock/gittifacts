# @app/evidence

Signed, independently verifiable evidence about a code change, stored next to the commit
it describes.

A CI sandbox measures a change (did the new test fail before and pass after? how much of
the changed code is covered? which dependencies moved? did a sensitive path change?),
signs the results with an Ed25519 key, and attaches them to the head commit as a git note
under `refs/notes/evidence`. Anyone with the repository and the public key can check that
note later, offline, with one command. They do not need to trust the platform's database
or UI.

This package is standalone. It imports nothing from the rest of the app, depends only on
`zod`, and its core runs unchanged on Cloudflare Workers, browsers and Node 22 (WebCrypto
only).

## What an attestation proves, and what it does not

A verified attestation proves that:

- the holder of a trusted signing key asserted exactly these evidence items for exactly
  this `changeId` and `headSha`;
- none of those three fields changed after signing. Any edit, reorder, removal or
  injected field fails verification;
- when checked with the CLI against a commit, the note attached to that commit names that
  commit as its `headSha`. A valid note copied onto another commit fails.

It does not prove that:

- **the evidence is true.** The signature says the signer reported these results, not that
  the results are correct. Trust in the measurements is trust in the sandbox that holds
  the key. Protect that key accordingly.
- **every item was measured.** Each item has `status: ok | skipped | error`. A validly
  signed `error` item records that the measurement failed. It is not a pass. Treat
  unknown as risk.
- **anything about the base.** The signed payload binds the head commit only. Base
  commits appear inside items (for example `red-green.base.sha`) as the signer's claim.
- **when it was signed.** `attestation.signedAt`, `attestation.signer` and
  `attestation.keyId` are not covered by the signature. A wrong `keyId` simply fails to
  verify. `signedAt` is only used to apply a key's `notAfter`, so a leaked retired key can
  still backdate a signature. Rotate keys, and remove compromised keys from the key set
  (don't only expire them).
- **model judgments are facts.** `llm-judgment` items are signed opinions and may only
  raise risk.
- **anything when the note is missing.** No note means no evidence. It is not a failed
  check, and it is not a pass.

## Note format

One note per head commit, under `refs/notes/evidence`. The note is pretty-printed JSON
with a trailing newline:

```json
{
  "format": "gittifacts.evidence/v1",
  "changeId": "chg_01JABCDEF",
  "headSha": "2222222222222222222222222222222222222222",
  "attestation": {
    "alg": "Ed25519",
    "keyId": "q3Jm6tW0bJ0bq0Ck2y1y3A",
    "payloadDigest": "<base64url SHA-256 of the signed bytes>",
    "signature": "<base64url Ed25519 signature>",
    "signedAt": "2026-10-01T12:00:00.000Z",
    "signer": "gittifacts-ci",
    "v": 1
  },
  "items": [{ "id": "red-green", "kind": "red-green", "status": "ok", "...": "..." }]
}
```

- **Signed bytes:** UTF-8 of RFC 8785 canonical JSON of exactly
  `{"changeId", "headSha", "items"}`. Keys are sorted by UTF-16 code units, there is no
  whitespace, and numbers use ECMAScript form. Any JCS implementation in any language can
  reproduce them.
- **`keyId`:** base64url of the first 16 bytes of SHA-256(raw 32-byte public key).
- **`payloadDigest`:** base64url SHA-256 of the signed bytes. It is redundant with the
  signature, but it lets a verifier report that the content changed rather than only that
  the signature is bad.
- **Appends:** `git notes append` concatenates documents with a blank line between them.
  The last complete JSON document is authoritative, so an appended forgery fails the
  commit instead of falling back to an older valid document. An unterminated trailing
  fragment is ignored. `decodeNotes` returns every document.

Notes are not pushed or fetched by default:

```sh
git push origin refs/notes/evidence
git fetch origin refs/notes/evidence:refs/notes/evidence
```

## Verifying

```sh
pnpm verify-attestation --repo . --commit HEAD --public-key <base64url>
pnpm verify-attestation --repo . --commit <sha> --keys keys.json
pnpm verify-attestation --repo . --commit <sha> --keys-url https://example.com/evidence-keys.json
pnpm verify-attestation --file note.json --commit <sha> --public-key <base64url>
```

Add `--json` for machine output and `--ref` for a different notes ref. The exit code is
`0` when verified, `1` when not verified, and `2` for usage or configuration errors.

```text
gittifacts evidence attestation (. refs/notes/evidence)
  commit    2222222222222222222222222222222222222222
  change    chg_01JABCDEF
  headSha   2222222222222222222222222222222222222222 matches commit
  signer    gittifacts-ci | key q3Jm6tW0bJ0bq0Ck2y1y3A (2026) | signed 2026-10-01T12:00:00.000Z
  items (4)
    ok      red-green        proven (1 test)
    ok      coverage         75% of 4 changed executable lines covered
    error   mutation         measurement failed: stryker crashed
    ok      sensitive-paths  no hits (1 pattern)
    (1 item(s) not measured: a valid signature does not make them pass)
  verdict   VERIFIED - signed by a trusted key and bound to 222222222222
```

**Standalone script.** `pnpm --filter @app/evidence build:cli` writes
`dist/verify-attestation.mjs` and `dist/keygen.mjs`. These are single files with no
dependencies, so `node verify-attestation.mjs ...` works on any Node 22 machine with
`git`.

**Key sets** (`--keys`, `--keys-url`) are `[{ publicKey, keyId?, notAfter?, name? }]`
or `{ "keys": [...] }`.

- If an entry states a `keyId` that does not match its public key, the entry is ignored.
- `notAfter` rejects signatures dated after it (`expired-key`) while older notes keep
  verifying.
- To rotate, add the new key, give the old one `notAfter`, and switch the signer.
- `--keys-url` must be HTTPS. Plain HTTP is allowed only on loopback, because keys fetched
  over an unauthenticated channel would make the check meaningless.

**Keys.** `tsx packages/evidence/src/cli/keygen.ts` prints
`{ keyId, publicKey, privateKey }`. The private key is base64url PKCS#8 and the public key
is base64url raw 32 bytes. Store the private key as a secret (for example
`wrangler secret put`) and publish the public key.

## Library

```ts
import { signEvidence, verifyEvidence, encodeNote, decodeNote } from "@app/evidence";

const signed = await signEvidence({ changeId, headSha, items }, { privateKey, publicKey, name: "ci" });
const noteText = encodeNote(signed); // git notes --ref=refs/notes/evidence add -F - <headSha>

const result = await verifyEvidence(decodeNote(noteText), trustedKeysOrPublicKey);
if (result.ok) use(result.evidence); // the schema-validated bundle
else console.error(result.reason, result.detail);
```

Verification never throws on bad input. Failure reasons are `schema`, `unknown-key`,
`digest-mismatch`, `bad-signature` and `expired-key`. To check the stored bytes exactly,
including any injected fields, pass the raw document from `lastNoteDocument(text)`.

`signDocument(value, signer, { purpose })` and `verifyDocument(value, sig, keys, { purpose })`
sign any JSON value with the same canonicalization (for example plan approvals and
audit-log entries). The signed bytes are canonical `{document, purpose}`, so a document
signature can never pass as an evidence attestation or be reused for another purpose.

`@app/evidence/node` adds Node-only helpers: `readNote`, `writeNote`, `resolveCommit`,
`loadKeySetFile` and `loadKeySetUrl`.

## Producers

Producers are pure functions that turn tool output into evidence items, with no I/O. The
CI sandbox runs the tools and passes the output in.

| Producer | Input | Output |
|---|---|---|
| `parseUnifiedDiff` | `git diff [-U0] -M` text | files (status, renames, binary, modes), hunks, `changedLines` (head line numbers) |
| `redGreenVerdict` / `redGreenProof` | listed tests + base/head results | `red-green`. Proven iff ≥1 test is red on base and all are green on head. Flaky counts against. |
| `semverBump` / `dependencyDiff` | npm specs / `package.json` texts by path | `dependencies`, including new or changed `preinstall`/`install`/`postinstall`/`prepare` scripts |
| `parseLcov` / `parseIstanbul` / `changedLineCoverage` | lcov or `coverage-final.json` + changed lines | `coverage` over executable changed lines. Files missing from the report are listed in `unmeasuredFiles`. |
| `parseStrykerReport` / `mutationScore` | Stryker `mutation.json` + changed lines | `mutation`. Only mutants on changed lines count. If there are none, the item is `skipped`, never a free 100%. |
| `sensitivePathHits` (+ `matchPathPattern`, `matchGlob`) | paths + glob patterns | `sensitive-paths` |
| `diffApiSurface` / `publicApiDiff` | `{symbol: signature}` maps | `public-api`. Removed or changed symbols are breaking, added symbols are additive. |

| `parseConflicts` / `resolutionScope` | merged text with conflict markers + resolved files | which lines the conflict regions became (`conflictHunks`), whether anything else changed (`touchesOutsideConflictHunks`), leftover markers, novel lines |
| `conflictResolutionItem` / `conflictResolutionError` | scope + resolution diff + resolver identity | `conflict-resolution` (diff capped at 64 KB on a line boundary, `truncated` set) |
| `quarantineEvidence` | quarantined tests + the Change's affected test targets (or `null` = unknown) | `quarantine`. An unknown affected set counts every quarantined test as affected. |
| `diffLines` / `unifiedFileDiff` / `unifiedDiffOf` | before/after texts | Myers line diff; `diff --git` text that `git apply` accepts (no-EOL, CRLF, adds, deletes, quoted paths) |

Producers fail closed. Unparseable manifests, empty coverage reports, unknown mutant
statuses and invalid glob patterns produce `status: "error"` items, not silent passes.

### Merge-queue items

- **`conflict-resolution`** records a conflict resolved by the platform's resolver agent (never
  the Change's author): the upstream Changes it was resolved against, the resolution diff, the
  resolver's model, principal and prompt version, its rationale and, for semantic conflicts, the
  upstream Change it blamed. `conflictHunks` and `touchesOutsideConflictHunks` are computed by
  `resolutionScope`, not reported by the model. "Within the conflict hunks" is exact: the
  resolved file must equal the mechanical merge with each conflict region (markers included)
  replaced by something, every clean line kept verbatim and in order. Edits to files that were
  not in conflict, unparseable markers, and edits with no conflict hunk at all (semantic
  conflicts) are outside. `status: "error"` means the resolver failed; such an item counts as
  outside. Like `llm-judgment`, this item may only raise risk.
- **`quarantine`** lists tests the merge queue quarantined as suspected-flaky and, in
  `inAffectedSet`, the ones inside the Change's affected set. A quarantined test never silently
  counts as passing: a bundle whose test runs excluded or ignored quarantined tests must carry
  this item.
- `checkConflictResolution` and `checkQuarantine` report internal inconsistencies (for example an
  `inAffectedSet` id that is not quarantined).

The glob matcher has no dependencies. It supports `*`, `?`, `**`, `{a,b}` (nestable),
`[a-z]`/`[!a]` and `\` escapes, and dotfiles match. `matchPathPattern` adds
gitignore-style rules:

- A pattern without a `/` matches at any depth.
- A leading `/` anchors the pattern to the repository root.
- A trailing `/` matches directories only.
- A pattern that matches a directory also matches everything under it.

## Development

```sh
pnpm --filter @app/evidence typecheck   # Node types and @cloudflare/workers-types (src only)
pnpm --filter @app/evidence test        # includes an end-to-end CLI test against a temp git repo
pnpm --filter @app/evidence build:cli
```
