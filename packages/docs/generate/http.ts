/**
 * HTTP API reference, from the platform's OpenAPI document: `createApp()` evaluated in Node
 * (generate/lib/platform.ts), i.e. the route definitions themselves, not a deployed copy.
 */
import { cell, code, type GeneratedPage, header, join, table } from "./lib/md.js";
import { type OpenApiDocument, type OpenApiOperation, openApiDocument } from "./lib/platform.js";
import type { JsonSchema } from "./lib/schema.js";
import { typeOf } from "./lib/schema.js";

const GROUPS: readonly {
  file: string;
  title: string;
  nav: string;
  tags: readonly string[];
  blurb: string;
}[] = [
  {
    file: "reference/http-identity.md",
    title: "HTTP API: identity and auth",
    nav: "HTTP: identity and auth",
    tags: ["identity", "oauth", "keys"],
    blurb:
      "principals, agent tokens, OAuth (authorize, token, revoke, consent, device flow), agent sessions and signing keys",
  },
  {
    file: "reference/http-repos.md",
    title: "HTTP API: projects, repos and members",
    nav: "HTTP: repos and members",
    tags: ["projects", "repos", "members", "code"],
    blurb:
      "create_project, repos, Lane 0, deploy targets, import grants, members and invites, and a repo's code and history (tree, files, commits, activity)",
  },
  {
    file: "reference/http-plans.md",
    title: "HTTP API: plans and claims",
    nav: "HTTP: plans and claims",
    tags: ["plans", "claims"],
    blurb:
      "plans (draft, approve, reject, withdraw, attempts and the pick) and claiming an unclaimed project",
  },
  {
    file: "reference/http-changes.md",
    title: "HTTP API: changes",
    nav: "HTTP: changes",
    tags: ["changes", "blobs", "audit"],
    blurb:
      "changes, push tokens, diffs, evidence, tours, reviews, rollouts, the kill switch, blobs and the audit log",
  },
  {
    file: "reference/http-merge-queue.md",
    title: "HTTP API: merge queue",
    nav: "HTTP: merge queue",
    tags: ["merge-queue"],
    blurb:
      "enqueue, status, wait, dequeue, reprioritize, the queue overview, events, freeze and thaw",
  },
  {
    file: "reference/http-integrations.md",
    title: "HTTP API: integrations",
    nav: "HTTP: integrations",
    tags: ["integrations", "deployments", "git"],
    blurb:
      "the developer portal, installations, webhook deliveries, deployments and the read-only git proxy",
  },
  {
    file: "reference/http-github.md",
    title: "HTTP API: GitHub mode",
    nav: "HTTP: GitHub",
    tags: ["github"],
    blurb: "the GitHub App overview, install verification and the GitHub webhook receiver",
  },
  {
    file: "reference/http-platform.md",
    title: "HTTP API: MCP, webhooks and operators",
    nav: "HTTP: platform",
    tags: ["mcp", "webhooks", "internal"],
    blurb: "the MCP endpoint, the Workers Issues webhook and operator-only routes",
  },
];

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface Op {
  method: string;
  path: string;
  op: OpenApiOperation;
}

function operations(doc: OpenApiDocument): Op[] {
  const out: Op[] = [];
  for (const path of Object.keys(doc.paths).sort()) {
    const item = doc.paths[path] ?? {};
    for (const method of METHODS) {
      const op = item[method];
      if (op) out.push({ method: method.toUpperCase(), path, op });
    }
  }
  return out;
}

function resolve(doc: OpenApiDocument, s: unknown): JsonSchema | undefined {
  const schema = s as JsonSchema | undefined;
  if (schema?.$ref === undefined) return schema;
  const name = schema.$ref.split("/").at(-1) ?? "";
  return doc.components?.schemas?.[name] as JsonSchema | undefined;
}

function shape(doc: OpenApiDocument, s: unknown): string {
  const ref = (s as JsonSchema | undefined)?.$ref?.split("/").at(-1);
  const r = resolve(doc, s);
  if (r === undefined) return "";
  const req = new Set(r.required ?? []);
  const props = Object.entries(r.properties ?? {}).map(([k, v]) => {
    const t = (v as JsonSchema).$ref ? typeOf(v as JsonSchema) : "";
    return `${k}${req.has(k) ? "" : "?"}${t ? `: ${t}` : ""}`;
  });
  const fields = props.length === 0 ? typeOf(r) : `{ ${props.join(", ")} }`;
  return ref ? `${ref} ${fields}` : fields;
}

function authOf(op: OpenApiOperation): string {
  const schemes = (op.security ?? []).flatMap((s) => Object.keys(s));
  if (schemes.length === 0) return "none";
  return [...new Set(schemes)]
    .map((s) => (s === "Session" ? "session cookie" : s === "Bearer" ? "bearer token" : s))
    .join(" or ");
}

function section(doc: OpenApiDocument, { method, path, op }: Op): string {
  const params = (op.parameters ?? []).filter(
    (p) => p.in !== "header" || p.name !== "idempotency-key",
  );
  const idem = (op.parameters ?? []).some((p) => p.name === "idempotency-key");
  const body = op.requestBody?.content?.["application/json"]?.schema;
  const okCode = Object.keys(op.responses ?? {}).find((c) => c.startsWith("2"));
  const ok = okCode === undefined ? undefined : op.responses?.[okCode];
  const okSchema = ok?.content?.["application/json"]?.schema;
  const errors = Object.keys(op.responses ?? {}).filter((c) => !c.startsWith("2"));
  const facts = [
    `**Auth:** ${authOf(op)}`,
    idem ? "**Idempotency-Key:** accepted" : "",
    params.length > 0
      ? `**Parameters:** ${params.map((p) => `${code(p.name)} (${p.in}${p.required ? ", required" : ""})`).join(", ")}`
      : "",
    body !== undefined ? `**Body:** ${code(shape(doc, body))}` : "",
    okCode !== undefined
      ? `**${okCode}:** ${okSchema ? code(shape(doc, okSchema)) : cell(ok?.description ?? "")}`
      : "",
    errors.length > 0 ? `**Errors:** ${errors.join(", ")}` : "",
  ].filter(Boolean);
  return join(
    `### \`${method} ${path}\``,
    cell(op.summary ?? ""),
    op.description ?? "",
    facts.map((f) => `- ${f}`).join("\n"),
  );
}

export async function generateHttp(): Promise<GeneratedPage[]> {
  const doc = await openApiDocument();
  const ops = operations(doc);
  const groupOf = (op: Op) =>
    GROUPS.find((g) => g.tags.includes(op.op.tags?.[0] ?? "")) ?? GROUPS[GROUPS.length - 1]!;
  const sources = ["apps/platform/src/app.ts", "apps/platform/src/**/routes*.ts"];
  const pages: GeneratedPage[] = GROUPS.map((g, i) => {
    const mine = ops.filter((o) => groupOf(o) === g);
    const byTag = g.tags.map((t) => ({ t, ops: mine.filter((o) => (o.op.tags?.[0] ?? "") === t) }));
    const leftovers = mine.filter((o) => !g.tags.includes(o.op.tags?.[0] ?? ""));
    return {
      file: g.file,
      content: join(
        header(
          {
            title: g.title,
            nav: g.nav,
            description: `HTTP endpoints for ${g.blurb}.`,
            order: 31 + i,
          },
          sources,
        ),
        ...byTag.flatMap(({ t, ops: tagged }) =>
          tagged.length === 0 ? [] : [`## ${t}`, ...tagged.map((o) => section(doc, o))],
        ),
        leftovers.length > 0 ? "## Other" : "",
        ...leftovers.map((o) => section(doc, o)),
      ),
    };
  });
  const rows = ops.map((o) => {
    const g = groupOf(o);
    return [
      code(o.method),
      `[${code(o.path)}](/docs/${g.file.replace(/\.md$/, "")})`,
      cell(o.op.summary ?? ""),
    ];
  });
  pages.unshift({
    file: "reference/http-api.md",
    content: join(
      header(
        {
          title: "HTTP API",
          description: `All ${ops.length} HTTP operations of the platform, grouped by area, with auth, idempotency, bodies and error codes.`,
          order: 30,
        },
        sources,
      ),
      "JSON over HTTPS at `https://<host>`. The OpenAPI 3.1 document is at `https://<host>/openapi.json` (alias of `/api/v1/openapi.json`).",
      '- **Auth:** `Authorization: Bearer <token>` (agent, integration or OAuth token), or the browser session cookie for humans. See [Authenticate](/docs/guides/authenticate).\n- **Errors:** `{ "error": { "code", "message", "fix": { "explanation", "call"?, "command"?, "docsUrl"? }, "details"? } }` with a matching status. See [error codes](/docs/reference/errors).\n- **Retries:** send `Idempotency-Key` on create and mutate calls. The same key and body replays the first response; the same key with another body is `409 idempotency-key-reuse`.',
      table(["Method", "Path", "What it does"], rows),
    ),
  });
  return pages;
}
