/**
 * verify-attestation: check that a commit's evidence note is signed by a trusted key
 * and bound to that commit, and that its why note (refs/notes/why) is too.
 *
 *   verify-attestation --repo <path> --commit <rev> (--public-key <b64url> | --keys <file> | --keys-url <url>) [--require-why]
 *   verify-attestation --file <note.json> [--why-file <why.json>] [--commit <sha>] (--public-key ... | --keys ... | --keys-url ...)
 *
 * The why note is checked whenever there is one (always looked up in --repo mode; --why-file in
 * --file mode). A why note that is present but does not verify fails the run. A missing why note
 * is reported ("none") and does not fail the run unless --require-why is given: older commits
 * and evidence-only repos have none.
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
import {
  verifyWhyNote,
  WHY_NOTES_REF,
  type WhyNote,
  type WhyPrincipal,
  type WhyVerifyFailureReason,
} from "../why.js";

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  fetch?: typeof fetch;
}

export const VERIFY_USAGE = `Usage:
  verify-attestation --repo <path> --commit <rev> <key option> [--ref <notes-ref>] [--require-why] [--json]
  verify-attestation --file <note.json> [--why-file <why.json>] [--commit <sha>] <key option> [--require-why] [--json]

Key options (exactly one):
  --public-key <base64url>   trusted Ed25519 public key (raw 32 bytes, base64url)
  --keys <file.json>         key set: [{publicKey, keyId?, notAfter?, name?}] or {"keys": [...]}
  --keys-url <https-url>     same key set, fetched over HTTPS

Why notes (${WHY_NOTES_REF}): checked whenever present, with the same keys; a present
note that does not verify fails. A missing one is reported and passes unless --require-why.

Exit codes: 0 verified, 1 not verified, 2 usage or configuration error.
`;

type Failure =
  | VerifyFailureReason
  | "no-note"
  | "bad-note"
  | "commit-mismatch"
  | "unknown-commit"
  /** The evidence verified but the why note did not (see `why`). */
  | "why-note";

export interface WhyReport {
  /** verified: signed and bound; absent: no note; failed: present but not verified. */
  status: "verified" | "absent" | "failed";
  /** Whether this counts as a pass: verified, or absent without --require-why. */
  ok: boolean;
  reason?: WhyVerifyFailureReason | "no-note";
  detail?: string;
  source: string;
  required: boolean;
  bindingChecked: boolean;
  keyId?: string;
  keyName?: string;
  /** The note as stored (schema-valid). Only trustworthy when status is "verified". */
  note?: WhyNote;
}

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
  why?: WhyReport;
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

const short = (s: string) => s.slice(0, 12);

function render(r: Report): string {
  const lines: string[] = [];
  // r.ok is the overall result; "why-note" means the evidence itself verified.
  const evidenceOk = r.ok || r.reason === "why-note";
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
    lines.push(`  items (${r.items.length})${evidenceOk ? "" : " - UNVERIFIED, do not trust"}`);
    const w = Math.max(4, ...r.items.map((i) => i.kind.length));
    for (const i of r.items)
      lines.push(`    ${i.status.padEnd(7)} ${i.kind.padEnd(w)}  ${i.summary}`);
    const bad = r.items.filter((i) => i.status !== "ok").length;
    if (bad > 0)
      lines.push(`    (${bad} item(s) not measured: a valid signature does not make them pass)`);
  }
  lines.push(
    evidenceOk
      ? `  verdict   VERIFIED${r.bindingChecked ? ` - signed by a trusted key and bound to ${short(r.commit ?? r.headSha ?? "")}` : " - signature valid (commit binding not checked)"}`
      : `  verdict   NOT VERIFIED (${r.reason}): ${r.detail ?? ""}`,
  );
  if (r.why) lines.push(...renderWhy(r.why));
  return `${lines.join("\n")}\n`;
}

/**
 * A why note is free text written by people and agents: escape control, C1 and bidi characters so
 * a note cannot add lines (say, a fake verdict) or reorder what the terminal shows.
 */
const safe = (line: string) =>
  line.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const person = (p: WhyPrincipal) => `${p.name} (${p.kind} ${p.id})`;

function renderWhy(w: WhyReport): string[] {
  const n = w.note;
  const untrusted = n !== undefined && w.status === "failed" ? " - UNVERIFIED, do not trust" : "";
  const lines = ["", `gittifacts why note (${w.source})${untrusted}`];
  if (n) {
    lines.push(`  change    ${n.changeId} ${JSON.stringify(n.title)}`);
    const binding = !w.bindingChecked
      ? "(not checked: no --commit given)"
      : w.reason === "commit-mismatch"
        ? "MISMATCH"
        : "matches commit";
    lines.push(`  landedSha ${n.landedSha} ${binding}`);
    if (n.headSha !== n.landedSha) lines.push(`  headSha   ${n.headSha} (as reviewed)`);
    const acc = n.accountable ? `; accountable: ${person(n.accountable)}` : "";
    lines.push(`  author    ${person(n.author)}${acc}`);
    if (n.plan) {
      const by = n.plan.approvedBy
        ? `, approved by ${person(n.plan.approvedBy)}`
        : ", not approved";
      lines.push(`  plan      ${n.plan.id} ${JSON.stringify(n.plan.title)}${by}`);
      lines.push(`  intent    ${n.plan.intent}`);
      for (const c of n.plan.acceptanceCriteria) lines.push(`  accept    - ${c}`);
    } else lines.push("  plan      none (no approved intent)");
    const reasons = n.laneReasons.map((r) => r.code).join(", ");
    lines.push(`  lane      ${n.lane ?? "unknown"}${reasons ? ` (${reasons})` : ""}`);
    const approvals = n.approvals.map((a) => person(a.reviewer)).join(", ");
    lines.push(`  approvals ${approvals || "none"}`);
    if (n.agentTrace) lines.push(`  trace     ${n.agentTrace.provider} ${n.agentTrace.traceId}`);
    lines.push(`  evidence  ${n.evidenceId ?? "none"}`);
    const key = w.keyId
      ? `key ${w.keyId}${w.keyName ? ` (${w.keyName})` : ""}`
      : `key ${n.attestation.keyId}`;
    lines.push(`  signer    ${key} | landed ${n.landedAt}`);
  }
  if (w.status === "verified") {
    lines.push(
      `  verdict   VERIFIED${w.bindingChecked ? ` - signed by a trusted key and landed as ${short(n?.landedSha ?? "")}` : " - signature valid (commit binding not checked)"}`,
    );
  } else if (w.status === "absent" && !w.required) {
    lines.push(
      `  verdict   NONE - ${w.detail ?? "no why note"} (not required; --require-why fails on this)`,
    );
  } else {
    lines.push(`  verdict   NOT VERIFIED (${w.reason}): ${w.detail ?? ""}`);
  }
  return lines.map(safe);
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

/** The evidence note's report (`text` is the note; null when there is none). */
async function checkEvidence(
  text: string,
  keys: KeySet | string,
  source: string,
  commit: string | undefined,
): Promise<Report> {
  const base: Report = { ok: false, source, bindingChecked: commit !== undefined };
  if (commit !== undefined) base.commit = commit;

  let doc: unknown;
  try {
    doc = lastNoteDocument(text);
  } catch (e) {
    if (!(e instanceof EvidenceNoteError)) throw e;
    return { ...base, reason: "bad-note", detail: e.message };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ...base, reason: "bad-note", detail: "note is not a JSON object" };
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
      ...base,
      reason: "schema",
      detail: `note format is ${JSON.stringify(header.format)}, expected ${EVIDENCE_NOTE_FORMAT}`,
    };
  }
  const result = await verifyEvidence(doc, keys);
  if (!result.ok) return { ...base, reason: result.reason, detail: result.detail };
  base.keyId = result.keyId;
  if (result.keyName !== undefined) base.keyName = result.keyName;
  if (commit !== undefined && result.evidence.headSha !== commit) {
    return {
      ...base,
      reason: "commit-mismatch",
      detail: `note is for ${result.evidence.headSha}, not ${commit}`,
    };
  }
  return { ...base, ok: true };
}

/** The why note's report; `text` null means there is no note (`absentDetail` says where). */
async function checkWhy(
  text: string | null,
  keys: KeySet | string,
  where: { source: string; absentDetail: string },
  commit: string | undefined,
  required: boolean,
): Promise<WhyReport> {
  const base = { source: where.source, required, bindingChecked: commit !== undefined };
  if (text === null) {
    return {
      ...base,
      status: "absent",
      ok: !required,
      reason: "no-note",
      detail: where.absentDetail,
    };
  }
  const r = await verifyWhyNote(text, keys, commit === undefined ? {} : { commit });
  if (!r.ok) {
    const failed: WhyReport = {
      ...base,
      status: "failed",
      ok: false,
      reason: r.reason,
      detail: r.detail,
    };
    if (r.note) failed.note = r.note;
    return failed;
  }
  const ok: WhyReport = { ...base, status: "verified", ok: true, keyId: r.keyId, note: r.note };
  if (r.keyName !== undefined) ok.keyName = r.keyName;
  return ok;
}

/** Attach the why report; a why note that does not pass fails an otherwise verified run. */
function withWhy(r: Report, why: WhyReport | undefined): Report {
  if (why === undefined) return r;
  if (!r.ok || why.ok) return { ...r, why };
  return {
    ...r,
    ok: false,
    reason: "why-note",
    detail: `why note: ${why.reason}: ${why.detail ?? ""}`,
    why,
  };
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
      "why-file": { type: "string" },
      ref: { type: "string" },
      "public-key": { type: "string" },
      keys: { type: "string" },
      "keys-url": { type: "string" },
      "require-why": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) throw new UsageError("");
  const json = values.json === true;
  const requireWhy = values["require-why"] === true;
  if (values.file === undefined && values.commit === undefined)
    throw new UsageError("--commit is required (or use --file)");
  if (values.file !== undefined && values.repo !== undefined)
    throw new UsageError("--file and --repo are mutually exclusive");
  if (values["why-file"] !== undefined && values.file === undefined)
    throw new UsageError("--why-file goes with --file (--repo reads refs/notes/why itself)");
  if (requireWhy && values.file !== undefined && values["why-file"] === undefined)
    throw new UsageError("with --file, --require-why needs --why-file");
  const keys = await loadKeys(values, io);

  if (values.file !== undefined) {
    const commit = values.commit;
    if (commit !== undefined && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
      throw new UsageError("with --file, --commit must be a full commit id");
    }
    const report = await checkEvidence(
      await readFile(values.file, "utf8"),
      keys,
      values.file,
      commit,
    );
    const whyFile = values["why-file"];
    if (whyFile === undefined) return { json, report };
    const why = await checkWhy(
      await readFile(whyFile, "utf8"),
      keys,
      { source: whyFile, absentDetail: "" },
      commit,
      requireWhy,
    );
    return { json, report: withWhy(report, why) };
  }

  const repo = values.repo ?? ".";
  const ref = values.ref ?? EVIDENCE_NOTES_REF;
  const source = `${repo} ${ref}`;
  const commit = await resolveCommit(repo, values.commit!);
  if (commit === null) {
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
  const note = await readNote(repo, commit, ref);
  const report: Report =
    note === null
      ? {
          ok: false,
          reason: "no-note",
          detail: `no note under ${ref} for ${commit}`,
          source,
          commit,
          bindingChecked: false,
        }
      : await checkEvidence(note, keys, source, commit);
  const why = await checkWhy(
    await readNote(repo, commit, WHY_NOTES_REF),
    keys,
    {
      source: `${repo} ${WHY_NOTES_REF}`,
      absentDetail: `no note under ${WHY_NOTES_REF} for ${commit}`,
    },
    commit,
    requireWhy,
  );
  return { json, report: withWhy(report, why) };
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
