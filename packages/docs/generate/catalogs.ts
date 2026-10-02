/**
 * Catalog references: error codes and their fixes (@app/conventions), merge-queue ejections
 * (@app/merge-queue), lane reason codes (@app/classifier) and evidence kinds (@app/evidence).
 */
import { join as pathJoin } from "node:path";
import { GATES, REASON_CODES } from "@app/classifier";
import { ERROR_CODE_ALIASES, ERROR_CODES, ERROR_STATUS, fixFor } from "@app/conventions";
import * as evidence from "@app/evidence";
import { EjectCode, ejectReason } from "@app/merge-queue";
import { z } from "zod";
import { cell, code, type GeneratedPage, header, join, table } from "./lib/md.js";
import { type JsonSchema, typeOf } from "./lib/schema.js";
import { declarationDoc, enumMemberDocs, propertyDocs } from "./lib/tsdoc.js";

const REPO = pathJoin(import.meta.dirname, "..", "..", "..");

function errorsPage(): GeneratedPage {
  const rows = ERROR_CODES.map((c) => {
    const fix = fixFor(c);
    const next = [fix.call ? code(fix.call) : "", fix.command ? code(fix.command) : ""]
      .filter(Boolean)
      .join(" or ");
    return [code(c), String(ERROR_STATUS[c]), cell(fix.explanation), cell(next)];
  });
  const ejectDocs = enumMemberDocs(
    pathJoin(REPO, "packages/merge-queue/src/schema.ts"),
    "EjectCode",
  );
  const ejects = EjectCode.options.map((c) => {
    const r = ejectReason({
      changeId: "<changeId>",
      code: c,
      message: "",
      failingTests: ["<test>"],
      upstream: ["<upstreamChangeId>"],
      files: ["<file>"],
    });
    const next = [r.fix.call ? code(r.fix.call) : "", r.fix.command ? code(r.fix.command) : ""]
      .filter(Boolean)
      .join(" or ");
    return [code(c), cell(ejectDocs.get(c) ?? ""), cell(r.fix.explanation), cell(next)];
  });
  return {
    file: "reference/errors.md",
    content: join(
      header(
        {
          title: "Error codes and fixes",
          nav: "Error codes",
          description:
            "Every platform error code with its HTTP status and the fix the platform sends with it, plus merge-queue ejection codes.",
          order: 50,
        },
        [
          "packages/conventions/src/fixes.ts",
          "packages/merge-queue/src/eject.ts",
          "packages/merge-queue/src/schema.ts",
        ],
        "Every error from the HTTP API, the MCP server and the CLI has this shape. `fix.call` is an MCP tool call and `fix.command` a shell command that resolves it; run them as they are. Placeholders such as `<changeId>` are filled in with real ids in live errors.",
      ),
      '```json\n{ "error": { "code": "plan-not-approved", "message": "…", "fix": { "explanation": "…", "call": "get_change_status({ changeId: \\"chg_1\\" })", "docsUrl": "https://<host>/start" } } }\n```',
      "## Platform errors",
      table(["Code", "HTTP", "What to do", "Next call or command"], rows),
      "## Aliases",
      "Older names map to the codes above.",
      table(
        ["Alias", "Code"],
        Object.entries(ERROR_CODE_ALIASES).map(([a, c]) => [code(a), code(c)]),
      ),
      "## Merge-queue ejections",
      "An ejected queue entry carries `{ code, message, fix, evidenceRefs, failingTests, upstream }`. `wait_for_merge` and `queue_status` return it.",
      table(["Code", "When", "What to do", "Next call or command"], ejects),
    ),
  };
}

function lanesPage(): GeneratedPage {
  const entries = Object.entries(REASON_CODES).sort(
    ([a, x], [b, y]) => y.lane - x.lane || a.localeCompare(b),
  );
  const rows = entries.map(([c, s]) => [
    code(c),
    String(s.lane),
    s.outcome,
    cell(s.gates.join(", ")),
    cell(s.condition),
  ]);
  return {
    file: "reference/lane-reasons.md",
    content: join(
      header(
        {
          title: "Lane reason codes",
          nav: "Lane reasons",
          description: `All ${entries.length} reason codes the classifier can put on a Change: the lane each one forces, its gate and when it fires.`,
          order: 52,
        },
        ["packages/classifier/src/reasons.ts"],
        "A Change's lane is the highest lane over its reasons. Every reason has a stable code (stored on the Change as `laneReasons[]`) and maps to one or more Lane-0 gates. `outcome` says how a raised reason shows on its gate: `fail` (measured and bad), `unknown` (not measured or errored: unknown escalates) or `pass`.",
      ),
      "## Lane-0 gates",
      `A Change is Lane 0 only when every gate passes. The checklist in \`get_change_status\` lists them in this order: ${GATES.map(code).join(", ")}.`,
      "## Reasons",
      table(["Code", "Lane", "Outcome", "Gates", "When"], rows),
    ),
  };
}

type ZodObjectLike = z.ZodObject<z.ZodRawShape>;

function evidencePage(): GeneratedPage {
  const docs = propertyDocs(pathJoin(REPO, "packages/evidence/src/schema.ts"));
  const kinds: { name: string; kind: string; schema: ZodObjectLike }[] = [];
  for (const [name, value] of Object.entries(evidence)) {
    if (!(value instanceof z.ZodObject)) continue;
    const kind = (value as ZodObjectLike).shape.kind;
    if (kind instanceof z.ZodLiteral && typeof kind.value === "string") {
      kinds.push({ name, kind: kind.value, schema: value as ZodObjectLike });
    }
  }
  kinds.sort((a, b) => a.kind.localeCompare(b.kind));
  const COMMON = new Set(["id", "status", "note", "logRef", "kind"]);
  const sections = kinds.flatMap(({ name, kind, schema }) => {
    const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
    const req = new Set(json.required ?? []);
    const rows = Object.entries(json.properties ?? {})
      .filter(([k]) => !COMMON.has(k))
      .map(([k, v]) => [
        code(`${k}${req.has(k) ? "" : "?"}`),
        cell(typeOf(v)),
        cell(docs.get(`${name}#${k}`) ?? ""),
      ]);
    return [
      `### \`${kind}\``,
      `Schema \`${name}\`. ${declarationDoc(pathJoin(REPO, "packages/evidence/src/schema.ts"), name)}`.trim(),
      table(["Field", "Type", "Meaning"], rows),
    ];
  });
  return {
    file: "reference/evidence-kinds.md",
    content: join(
      header(
        {
          title: "Evidence kinds",
          description: `The ${kinds.length} evidence item kinds a signed evidence bundle can hold, with their fields.`,
          order: 51,
        },
        ["packages/evidence/src/schema.ts"],
        `Evidence is \`{ changeId, headSha, items[], attestation }\`, signed with Ed25519 over the canonical JSON of \`{ changeId, headSha, items }\`, stored in D1 and as a git note on the head commit under \`${evidence.EVIDENCE_NOTES_REF}\` (format \`${evidence.EVIDENCE_NOTE_FORMAT}\`). Read it with \`get_evidence\`.`,
      ),
      "## Fields every item has",
      table(
        ["Field", "Type", "Meaning"],
        [
          [code("id"), "string", cell(docs.get("id") ?? "")],
          [code("kind"), "string", "One of the kinds below."],
          [
            code("status"),
            cell('"ok" | "skipped" | "error"'),
            cell(declarationDoc(pathJoin(REPO, "packages/evidence/src/schema.ts"), "SignalStatus")),
          ],
          [code("note?"), "string", cell(docs.get("note") ?? "")],
          [code("logRef?"), "string", cell(docs.get("logRef") ?? "")],
        ],
      ),
      "A `skipped` or `error` item is never read as a pass: it raises the lane ([lane reasons](/docs/reference/lane-reasons)).",
      "## Kinds",
      ...sections,
    ),
  };
}

export function generateCatalogs(): GeneratedPage[] {
  return [errorsPage(), lanesPage(), evidencePage()];
}
