/**
 * verify-attestation: check that a commit's evidence note is signed by a trusted key
 * and bound to that commit.
 *
 *   verify-attestation --repo <path> --commit <rev> (--public-key <b64url> | --keys <file> | --keys-url <url>)
 *   verify-attestation --file <note.json> [--commit <sha>] (--public-key ... | --keys ... | --keys-url ...)
 *
 * Exit codes: 0 verified, 1 not verified, 2 usage/configuration error.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { type VerifyFailureReason, verifyEvidence } from "../attest.js";
import { KeyError, type KeySet } from "../keys.js";
import { GitError, readNote, resolveCommit } from "../node/git.js";
import { loadKeySetFile, loadKeySetUrl } from "../node/keys.js";
import { EvidenceNoteError, lastNoteDocument } from "../notes.js";
import {
  EVIDENCE_NOTE_FORMAT,
  EVIDENCE_NOTES_REF,
  type EvidenceItem,
  SignedEvidence,
} from "../schema.js";
import { summarizeItem } from "../summary.js";

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  fetch?: typeof fetch;
}

export const VERIFY_USAGE = `Usage:
  verify-attestation --repo <path> --commit <rev> <key option> [--ref <notes-ref>] [--json]
  verify-attestation --file <note.json> [--commit <sha>] <key option> [--json]

Key options (exactly one):
  --public-key <base64url>   trusted Ed25519 public key (raw 32 bytes, base64url)
  --keys <file.json>         key set: [{publicKey, keyId?, notAfter?, name?}] or {"keys": [...]}
  --keys-url <https-url>     same key set, fetched over HTTPS

Exit codes: 0 verified, 1 not verified, 2 usage or configuration error.
`;

type Failure = VerifyFailureReason | "no-note" | "bad-note" | "commit-mismatch" | "unknown-commit";

interface Report {
  ok: boolean;
  reason?: Failure;
  detail?: string;
  source: string;
  commit?: string;
  changeId?: string;
  headSha?: string;
  keyId?: string;
  keyName?: string;
  signer?: string;
  signedAt?: string;
  bindingChecked: boolean;
  items?: { id: string; kind: string; status: string; summary: string }[];
}

class UsageError extends Error {}

function itemsOf(doc: unknown): Report["items"] {
  const parsed = SignedEvidence.safeParse(doc);
  if (!parsed.success) return undefined;
  return parsed.data.items.map((i: EvidenceItem) => ({
    id: i.id,
    kind: i.kind,
    status: i.status,
    summary: summarizeItem(i),
  }));
}

function render(r: Report): string {
  const lines: string[] = [];
  const short = (s: string) => s.slice(0, 12);
  lines.push(`gittifacts evidence attestation (${r.source})`);
  if (r.commit) lines.push(`  commit    ${r.commit}`);
  if (r.changeId) lines.push(`  change    ${r.changeId}`);
  if (r.headSha) {
    const binding = !r.bindingChecked
      ? "(not checked: no --commit given)"
      : r.reason === "commit-mismatch"
        ? "MISMATCH"
        : "matches commit";
    lines.push(`  headSha   ${r.headSha} ${binding}`);
  }
  if (r.keyId || r.signer) {
    const key = r.keyId ? `key ${r.keyId}${r.keyName ? ` (${r.keyName})` : ""}` : "";
    lines.push(
      `  signer    ${[r.signer, key, r.signedAt ? `signed ${r.signedAt}` : ""].filter(Boolean).join(" | ")}`,
    );
  }
  if (r.items) {
    lines.push(`  items (${r.items.length})${r.ok ? "" : " - UNVERIFIED, do not trust"}`);
    const w = Math.max(4, ...r.items.map((i) => i.kind.length));
    for (const i of r.items)
      lines.push(`    ${i.status.padEnd(7)} ${i.kind.padEnd(w)}  ${i.summary}`);
    const bad = r.items.filter((i) => i.status !== "ok").length;
    if (bad > 0)
      lines.push(`    (${bad} item(s) not measured: a valid signature does not make them pass)`);
  }
  lines.push(
    r.ok
      ? `  verdict   VERIFIED${r.bindingChecked ? ` - signed by a trusted key and bound to ${short(r.commit ?? r.headSha ?? "")}` : " - signature valid (commit binding not checked)"}`
      : `  verdict   NOT VERIFIED (${r.reason}): ${r.detail ?? ""}`,
  );
  return `${lines.join("\n")}\n`;
}

async function loadKeys(
  values: { "public-key"?: string; keys?: string; "keys-url"?: string },
  io: CliIo,
): Promise<KeySet | string> {
  const given = [values["public-key"], values.keys, values["keys-url"]].filter(
    (v) => v !== undefined,
  );
  if (given.length !== 1)
    throw new UsageError("give exactly one of --public-key, --keys, --keys-url");
  if (values["public-key"] !== undefined) return values["public-key"];
  if (values.keys !== undefined) return loadKeySetFile(values.keys);
  return loadKeySetUrl(values["keys-url"]!, io.fetch ?? fetch);
}

async function verify(
  argv: readonly string[],
  io: CliIo,
): Promise<{ report: Report; json: boolean }> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      commit: { type: "string" },
      file: { type: "string" },
      ref: { type: "string" },
      "public-key": { type: "string" },
      keys: { type: "string" },
      "keys-url": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) throw new UsageError("");
  const json = values.json === true;
  if (values.file === undefined && values.commit === undefined)
    throw new UsageError("--commit is required (or use --file)");
  if (values.file !== undefined && values.repo !== undefined)
    throw new UsageError("--file and --repo are mutually exclusive");
  const keys = await loadKeys(values, io);

  const ref = values.ref ?? EVIDENCE_NOTES_REF;
  let text: string;
  let commit: string | undefined;
  let source: string;
  if (values.file !== undefined) {
    source = values.file;
    text = await readFile(values.file, "utf8");
    commit = values.commit;
    if (commit !== undefined && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
      throw new UsageError("with --file, --commit must be a full commit id");
    }
  } else {
    const repo = values.repo ?? ".";
    source = `${repo} ${ref}`;
    const resolved = await resolveCommit(repo, values.commit!);
    if (resolved === null) {
      return {
        json,
        report: {
          ok: false,
          reason: "unknown-commit",
          detail: `${values.commit} is not a commit in ${repo}`,
          source,
          bindingChecked: false,
        },
      };
    }
    commit = resolved;
    const note = await readNote(repo, commit, ref);
    if (note === null) {
      return {
        json,
        report: {
          ok: false,
          reason: "no-note",
          detail: `no note under ${ref} for ${commit}`,
          source,
          commit,
          bindingChecked: false,
        },
      };
    }
    text = note;
  }

  const base: Report = { ok: false, source, bindingChecked: commit !== undefined };
  if (commit !== undefined) base.commit = commit;

  let doc: unknown;
  try {
    doc = lastNoteDocument(text);
  } catch (e) {
    if (!(e instanceof EvidenceNoteError)) throw e;
    return { json, report: { ...base, reason: "bad-note", detail: e.message } };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { json, report: { ...base, reason: "bad-note", detail: "note is not a JSON object" } };
  }
  const header = doc as Record<string, unknown>;
  if (typeof header.changeId === "string") base.changeId = header.changeId;
  if (typeof header.headSha === "string") base.headSha = header.headSha;
  const att = header.attestation as Record<string, unknown> | undefined;
  if (att && typeof att.signer === "string") base.signer = att.signer;
  if (att && typeof att.signedAt === "string") base.signedAt = att.signedAt;
  const items = itemsOf(doc);
  if (items) base.items = items;

  if (header.format !== EVIDENCE_NOTE_FORMAT) {
    return {
      json,
      report: {
        ...base,
        reason: "schema",
        detail: `note format is ${JSON.stringify(header.format)}, expected ${EVIDENCE_NOTE_FORMAT}`,
      },
    };
  }
  const result = await verifyEvidence(doc, keys);
  if (!result.ok)
    return { json, report: { ...base, reason: result.reason, detail: result.detail } };
  base.keyId = result.keyId;
  if (result.keyName !== undefined) base.keyName = result.keyName;
  if (commit !== undefined && result.evidence.headSha !== commit) {
    return {
      json,
      report: {
        ...base,
        reason: "commit-mismatch",
        detail: `note is for ${result.evidence.headSha}, not ${commit}`,
      },
    };
  }
  return { json, report: { ...base, ok: true } };
}

/** Run the CLI. Returns the process exit code. */
export async function runVerify(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { report, json } = await verify(argv, io);
    io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : render(report));
    return report.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof UsageError) {
      if (e.message) io.stderr(`verify-attestation: ${e.message}\n\n`);
      io.stderr(VERIFY_USAGE);
      return e.message ? 2 : 0;
    }
    if (e instanceof KeyError || e instanceof GitError) {
      io.stderr(`verify-attestation: ${e.message}\n`);
      return 2;
    }
    if (e instanceof TypeError && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS")) {
      io.stderr(`verify-attestation: ${e.message}\n\n${VERIFY_USAGE}`);
      return 2;
    }
    if (e instanceof Error && "code" in e && (e.code === "ENOENT" || e.code === "EACCES")) {
      io.stderr(`verify-attestation: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}
