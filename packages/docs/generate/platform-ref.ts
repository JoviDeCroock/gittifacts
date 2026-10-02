/**
 * References read from the platform Worker's own modules (generate/platform-entry.ts): limits and
 * quotas, webhook and stream events, discovery documents.
 */
import { join as pathJoin } from "node:path";
import { WS_LIMITS } from "@app/mcp";
import { QueueConfig, QueueEvent } from "@app/merge-queue";
import { z } from "zod";
import { cell, code, type GeneratedPage, header, join, table } from "./lib/md.js";
import { loadPlatform } from "./lib/platform.js";
import type { JsonSchema } from "./lib/schema.js";
import { mcpTools } from "./lib/tools.js";
import { propertyDocs } from "./lib/tsdoc.js";

const REPO = pathJoin(import.meta.dirname, "..", "..", "..");

/** Words for limits whose source has no doc comment (a doc comment in the source wins). */
const LIMIT_WORDS: Record<string, string> = {
  ttlDays:
    "Days until an unclaimed project and everything in it is deleted, unless a human claims it.",
  "ci.minutesPerDay": "CI minutes per project per UTC day.",
  "ci.minutesPerRun": "Longest single CI run.",
  "ci.maxLogBytes": "CI log kept per step.",
  "ci.maxArtifactBytes": "Largest build artifact.",
  "ci.instance": "Largest container size a step gets.",
  instance: "Container size.",
  maxExecTimeoutSec: "Longest `ws_exec` timeout.",
};

const FRONT_DOOR_WORDS: Record<string, string> = {
  start:
    "Machine guide: what the platform is, auth, the three calls to ship (markdown, or JSON with `Accept: application/json`)",
  llmsTxt: "llmstxt.org index",
  openapi: "OpenAPI 3.1 of the HTTP API (alias of `/api/v1/openapi.json`)",
  serverCard: "MCP server card (draft SEP-2127)",
  aiCatalog: "AI catalog pointing at the server card (draft)",
};

const OAUTH_WORDS: Record<string, string> = {
  authorize: "Authorization endpoint (code + PKCE S256)",
  token: "Token endpoint: authorization code, refresh token, device code",
  revoke: "Token revocation (RFC 7009)",
  deviceCode: "Device authorization (RFC 8628), used by `gittifacts login`",
  consent: "Consent screen a human sees",
  device: "Page where a human enters a device code",
  asMetadata: "Authorization server metadata (RFC 8414)",
};

const MiB = 1024 * 1024;

function human(key: string, v: unknown): string {
  if (typeof v === "number" && /bytes/i.test(key))
    return v >= MiB ? `${v / MiB} MB` : `${v / 1024} KB`;
  if (typeof v === "number" && /Ms$/.test(key))
    return v % 60_000 === 0 ? `${v / 60_000} min` : `${v / 1000} s`;
  if (typeof v === "number" && /Sec$/.test(key))
    return v % 60 === 0 && v >= 60 ? `${v / 60} min` : `${v} s`;
  if (typeof v === "number" && /cpuSecondsPerDay/.test(key)) return `${v / 60} vCPU-min/day`;
  if (typeof v === "object" && v !== null && "capacity" in v && "periodSec" in v) {
    const b = v as { capacity: number; periodSec: number };
    const per =
      b.periodSec === 3600
        ? "hour"
        : b.periodSec === 86_400
          ? "day"
          : `${b.periodSec / 86_400} days`;
    return `${b.capacity} per ${per}`;
  }
  return typeof v === "string" ? v : JSON.stringify(v);
}

function flat(o: Record<string, unknown>, prefix = ""): [string, unknown][] {
  return Object.entries(o).flatMap(([k, v]) => {
    const key = prefix === "" ? k : `${prefix}.${k}`;
    const isBucket = typeof v === "object" && v !== null && "capacity" in v;
    return typeof v === "object" && v !== null && !Array.isArray(v) && !isBucket
      ? flat(v as Record<string, unknown>, key)
      : [[key, v] as [string, unknown]];
  });
}

async function limitsPage(): Promise<GeneratedPage> {
  const p = await loadPlatform();
  const docs = propertyDocs(pathJoin(REPO, "apps/platform/src/limits/config.ts"));
  const unclaimed = flat(p.DEFAULT_UNCLAIMED_LIMITS).map(([k, v]) => [
    code(k),
    cell(human(k, v)),
    cell(docs.get(k) ?? LIMIT_WORDS[k] ?? docs.get(k.split(".")[0] ?? "") ?? ""),
  ]);
  const wsDocs = propertyDocs(pathJoin(REPO, "apps/platform/src/workspace/model.ts"));
  const ws = Object.keys(p.WORKSPACE_LIMITS.claimed).map((k) => [
    code(k),
    cell(human(k, p.WORKSPACE_LIMITS.claimed[k])),
    cell(human(k, p.WORKSPACE_LIMITS.unclaimed[k])),
    cell(wsDocs.get(k) ?? LIMIT_WORDS[k] ?? ""),
  ]);
  const wsTool = Object.entries(WS_LIMITS).map(([k, v]) => [code(k), cell(human(k, v))]);
  const tools = mcpTools();
  const timeout = (name: string) => {
    const s = (tools.find((t) => t.name === name)?.inputSchema as JsonSchema | undefined)
      ?.properties?.timeoutSec;
    return cell(`max ${s?.maximum ?? "—"} s per call. ${s?.description ?? ""}`.trim());
  };
  const qDocs = propertyDocs(pathJoin(REPO, "packages/merge-queue/src/config.ts"));
  const q = z.toJSONSchema(QueueConfig, { io: "input" }) as JsonSchema;
  const queueRows = Object.entries(q.properties ?? {})
    .filter(([, s]) => s.default !== undefined && typeof s.default !== "object")
    .map(([k, s]) => [code(k), cell(human(k, s.default)), cell(qDocs.get(k) ?? "")]);
  return {
    file: "reference/limits.md",
    content: join(
      header(
        {
          title: "Limits and quotas",
          description:
            "Every limit the platform enforces: unclaimed projects, remote workspaces, waits, tokens and sessions, rate limits and the merge queue.",
          order: 53,
        },
        [
          "apps/platform/src/limits/config.ts",
          "apps/platform/src/workspace/model.ts",
          "packages/mcp/src/tools/workspace.ts",
          "apps/platform/src/oauth/*.ts",
          "packages/merge-queue/src/config.ts",
        ],
        "Claiming a project lifts every unclaimed limit at once. Operators can override the unclaimed defaults with the `UNCLAIMED_LIMITS` (JSON) and `UNCLAIMED_TTL_DAYS` variables. A refused call returns `429 quota-exceeded` or `403 unclaimed-limit` with a fix that names the claim link ([error codes](/docs/reference/errors)).",
      ),
      "## Unclaimed projects",
      table(["Limit", "Default", "Meaning"], unclaimed),
      "## Remote workspaces",
      table(["Limit", "Claimed", "Unclaimed", "Meaning"], ws),
      "Per call:",
      table(["Limit", "Value"], wsTool),
      "## Waiting",
      table(
        ["Call", "Timeout"],
        [
          [code("wait_for_change"), timeout("wait_for_change")],
          [code("wait_for_merge"), timeout("wait_for_merge")],
          [code("gittifacts wait"), "re-issues the long-poll until `--timeout` (default 600 s)"],
        ],
      ),
      "## Tokens and sessions",
      table(
        ["What", "Value"],
        [
          ["OAuth access token (agents, integrations)", `${p.ACCESS_TOKEN_TTL_SEC / 60} min`],
          [
            "Agent session length (human picks)",
            `${p.SESSION_DAY_CHOICES.join(", ")} days (default ${p.DEFAULT_SESSION_DAYS})`,
          ],
          ["Authorization code", `${p.CODE_TTL_MS / 60_000} min, single use`],
          ["Authorization request", `${p.REQUEST_TTL_MS / 60_000} min`],
          ["Device code", `${p.DEVICE_CODE_TTL}, poll every ${p.DEVICE_POLL_INTERVAL}`],
          [
            "Integration refresh token",
            `${p.INTEGRATION_REFRESH_TTL_DAYS} days after its last rotation`,
          ],
          ["Agent scopes that can be delegated", p.DELEGABLE_SCOPES.map(code).join(", ")],
          ["Default delegated scopes", p.DEFAULT_SESSION_SCOPES.map(code).join(", ")],
          ["Never delegated", p.NEVER_DELEGATED.map(code).join(", ")],
        ],
      ),
      "## Webhook delivery",
      `Up to ${p.MAX_ATTEMPTS} attempts, retried after ${p.BACKOFF_SECONDS.map((s) => human("Sec", s)).join(", ")}. User agent \`${p.USER_AGENT}\`.`,
      "## Merge queue",
      table(["Setting", "Default", "Meaning"], queueRows),
    ),
  };
}

const EVENT_WORDS: Record<string, string> = {
  push: "A branch was pushed: the default branch of the repo, or the branch of a Change's fork. Carries `ref`, `before`, `after` and the clone URL.",
  "change.created": "A Change was opened (`start_change`).",
  "change.updated": "A Change's status, head, lane, evidence or tour changed (`changedFields`).",
  "change.merged":
    "The merge queue landed the Change on the default branch (`sha` = the merged commit).",
  "change.reverted": "The Change was reverted after merge.",
  "installation.created": "The integration was installed (or its repo selection updated).",
  "installation.deleted":
    "The integration was uninstalled. The last event an installation receives.",
  ping: "Sent on demand from the developer portal to test the endpoint. Always delivered.",
};

async function eventsPage(): Promise<GeneratedPage> {
  const p = await loadPlatform();
  const events = p.WebhookEvent.options;
  const missing = events.filter((e) => EVENT_WORDS[e] === undefined);
  if (missing.length > 0)
    throw new Error(`generate/platform-ref.ts: describe webhook events ${missing.join(", ")}`);
  const qEvents = QueueEvent.options.map((o) => {
    const shape = (o as unknown as z.ZodObject<z.ZodRawShape>).shape;
    const type = (shape.type as z.ZodLiteral<string>).value;
    return [
      code(type),
      cell(
        Object.keys(shape)
          .filter((k) => k !== "type")
          .map(code)
          .join(", "),
      ),
    ];
  });
  return {
    file: "reference/events.md",
    content: join(
      header(
        {
          title: "Webhook and stream events",
          nav: "Events",
          description:
            "Webhook events integrations can subscribe to, how deliveries are signed and retried, and the merge-queue and Change event streams.",
          order: 54,
        },
        [
          "apps/platform/src/integrations/scopes.ts",
          "apps/platform/src/integrations/delivery.ts",
          "packages/merge-queue/src/schema.ts",
        ],
      ),
      "## Webhook events",
      "Delivered to an integration's webhook URL for the repos its installation covers, when the installation holds `webhooks`. Default subscription: " +
        p.DEFAULT_EVENTS.map(code).join(", ") +
        ".",
      table(
        ["Event", "When"],
        events.map((e) => [code(e), cell(EVENT_WORDS[e] ?? "")]),
      ),
      "Every delivery is a `POST` with a JSON body `{ event, action, deliveryId, createdAt, installation, repository, … }` and these headers:",
      table(
        ["Header", "Value"],
        [
          [code("X-Gittifacts-Event"), "The event name."],
          [code("X-Gittifacts-Delivery"), "Delivery id. A redelivery keeps it."],
          [
            code("X-Gittifacts-Signature-256"),
            cell("`sha256=<hex HMAC-SHA-256 of the raw body>` with the webhook secret."),
          ],
          [code("User-Agent"), code(p.USER_AGENT)],
        ],
      ),
      `Delivery is at least once: dedupe on \`X-Gittifacts-Delivery\`. A non-2xx answer is retried ${p.BACKOFF_SECONDS.length} times (${p.BACKOFF_SECONDS.map((s) => human("Sec", s)).join(", ")}). Verification code: [Webhooks guide](/docs/guides/integrations/webhooks).`,
      "## Integration permissions",
      table(
        ["Scope", "Shown as", "Allows"],
        p.INTEGRATION_SCOPES.map((s) => [
          code(s),
          cell(p.SCOPE_WORDS[s]?.title ?? ""),
          cell(p.SCOPE_WORDS[s]?.description ?? ""),
        ]),
      ),
      `Never possible for an integration: ${p.NEVER_WORDS.map((w) => w.toLowerCase()).join("; ")}.`,
      "## Merge-queue events",
      "`GET /api/v1/repos/{repoId}/queue/events` streams these as Server-Sent Events (event ids are sequence numbers: reconnect with `Last-Event-ID` to resume).",
      table(["Type", "Fields"], qEvents),
      "## Change events",
      "`GET /api/v1/changes/{changeId}/events` streams one `change` event (`{ change }`) per update until the Change reaches a final status. Agents usually call `wait_for_change` instead.",
    ),
  };
}

async function discoveryPage(): Promise<GeneratedPage> {
  const p = await loadPlatform();
  const urls = {
    origin: "https://<host>",
    mcpUrl: "https://<host>/mcp",
    openapiUrl: "https://<host>/openapi.json",
    issuer: "https://<host>",
  };
  const docs = p.discoveryDocuments(urls, "<version>");
  const fd = Object.entries(p.FRONT_DOOR_PATHS).map(([k, v]) => [
    code(v),
    cell(FRONT_DOOR_WORDS[k] ?? k),
  ]);
  const oauth = Object.entries(p.OAUTH_PATHS).map(([k, v]) => [code(v), cell(OAUTH_WORDS[k] ?? k)]);
  return {
    file: "reference/discovery.md",
    content: join(
      header(
        {
          title: "Discovery documents",
          nav: "Discovery",
          description:
            "The machine-readable documents an agent finds from the platform's URL alone: /start, llms.txt, OpenAPI, MCP server card, AI catalog and OAuth metadata.",
          order: 55,
          audience: "agents",
        },
        [
          "apps/platform/src/routes/front-door.ts",
          "packages/conventions/src/mcp-discovery.ts",
          "apps/platform/src/oauth/urls.ts",
        ],
        "An agent told only `https://<host>` finds everything else from these. `GET /` also answers with RFC 8288 `Link` headers to them, and gives the start guide directly to `Accept: text/markdown` or `application/json`.",
      ),
      "## Front door",
      table(
        ["Path", "Document"],
        [
          ...fd,
          [
            code("/docs"),
            "These docs (HTML, or markdown with `Accept: text/markdown` or a `.md` suffix)",
          ],
          [code("/docs/llms-full.txt"), "Every docs page in one markdown file"],
        ],
      ),
      "## MCP discovery",
      table(
        ["Path", "Content-Type"],
        docs.map((d) => [code(d.path), code(d.contentType)]),
      ),
      ...docs
        .slice(0, 1)
        .map(
          (d) =>
            `Example (\`${d.path}\`):\n\n\`\`\`json\n${JSON.stringify(d.body, null, 2)}\n\`\`\``,
        ),
      "## OAuth",
      table(["Path", "Purpose"], oauth),
      "Signing keys for evidence, plan approvals and audit entries: `/.well-known/gittifacts-keys.json` ([Security model](/docs/security)).",
    ),
  };
}

export async function generatePlatformRefs(): Promise<GeneratedPage[]> {
  return [await limitsPage(), await eventsPage(), await discoveryPage()];
}
