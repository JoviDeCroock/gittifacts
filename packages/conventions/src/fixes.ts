/**
 * The `fix` for every error code (onboarding §5): what to do next, as an explanation plus a
 * concrete MCP `call` or shell `command`. The platform's error helper calls `fixFor(code, ctx)`;
 * `ctx` fills in ids and specifics so the fix is copy-pasteable.
 */
import type { ErrorFix } from "@app/domain";
import { call } from "./calls.js";

export const ERROR_CODES = [
  // auth
  "unauthorized",
  "insufficient-scope",
  "scope-not-allowed",
  "forbidden",
  "self-approval",
  // lifecycle rules
  "push-to-main",
  "red-green-missing",
  "plan-not-approved",
  "stale-head",
  "invalid-state",
  "threshold-not-met",
  // limits
  "quota-exceeded",
  "unclaimed-limit",
  "creation-disabled",
  "rate-limited",
  // requests
  "idempotency-key-reuse",
  "idempotency-key-in-flight",
  "invalid-request",
  "invalid-input",
  "not-found",
  "conflict",
  "payload-too-large",
  "http-error",
  // platform
  "upstream",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Other names for the same errors, so callers can't pick a code without a fix. */
export const ERROR_CODE_ALIASES: Record<string, ErrorCode> = {
  unauthenticated: "unauthorized",
  "forbidden-scope": "insufficient-scope",
  "fix-without-red-green": "red-green-missing",
  "red-green-proof-missing": "red-green-missing",
  "stale-ref": "stale-head",
  "too-many-requests": "rate-limited",
  "kill-switch": "creation-disabled",
};

/** HTTP status for each code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  "insufficient-scope": 403,
  "scope-not-allowed": 403,
  forbidden: 403,
  "self-approval": 403,
  "push-to-main": 403,
  "red-green-missing": 422,
  "plan-not-approved": 409,
  "stale-head": 409,
  "invalid-state": 409,
  "threshold-not-met": 409,
  "quota-exceeded": 429,
  "unclaimed-limit": 403,
  "creation-disabled": 503,
  "rate-limited": 429,
  "idempotency-key-reuse": 409,
  "idempotency-key-in-flight": 409,
  "invalid-request": 400,
  "invalid-input": 400,
  "not-found": 404,
  conflict: 409,
  "payload-too-large": 413,
  "http-error": 400,
  upstream: 502,
  internal: 500,
};

export interface FixContext {
  /** Platform origin, for URLs in explanations and `docsUrl`. */
  host?: string;
  repoId?: string;
  planId?: string;
  changeId?: string;
  /** insufficient-scope: the scopes the call needed. */
  requiredScopes?: readonly string[];
  /** red-green-missing: what the platform measured. */
  redGreen?: {
    baseSha?: string;
    /** New/changed test files in the Change (empty: none). */
    testFiles?: readonly string[];
    /** Of those, the ones that already pass on base (so they don't reproduce the bug). */
    passingOnBase?: readonly string[];
    /** Of those, the ones that fail on head (the fix doesn't make them pass). */
    failingOnHead?: readonly string[];
  };
  /** Command that runs one test file; the path is appended. Default `pnpm exec vitest run`. */
  testFileCommand?: string;
  /** plan-not-approved: the plan's current status. */
  planStatus?: string;
  /** stale-head: the head the platform has now. */
  currentHeadSha?: string;
  /** quota-exceeded / unclaimed-limit. */
  quota?: { name: string; limit: number; used?: number; resetsAt?: string };
  /** unclaimed-limit: what was refused, e.g. "production deploys". */
  refused?: string;
  claimUrl?: string;
  /** rate-limited / in-flight: seconds to wait. */
  retryAfterSec?: number;
  /** not-found: what kind of thing. */
  resource?: "repo" | "plan" | "change" | "project" | "tour" | "evidence";
}

const P = {
  repo: (c: FixContext) => c.repoId ?? "<repoId>",
  plan: (c: FixContext) => c.planId ?? "<planId>",
  change: (c: FixContext) => c.changeId ?? "<changeId>",
};

const list = (items: readonly string[]) => items.map((i) => `\`${i}\``).join(", ");

function redGreenFix(c: FixContext): ErrorFix {
  const rg = c.redGreen ?? {};
  const files = rg.testFiles ?? [];
  const runOne = c.testFileCommand ?? "pnpm exec vitest run";
  const base = rg.baseSha === undefined ? "the base commit" : `base ${rg.baseSha.slice(0, 12)}`;
  let problem: string;
  let target: string;
  if (files.length === 0) {
    problem = "This Change claims a fix but adds or changes no test.";
    target = "test/<area>.test.ts";
  } else if ((rg.passingOnBase ?? []).length > 0) {
    problem = `These tests already pass on ${base}, so they don't reproduce the bug: ${list(rg.passingOnBase ?? [])}.`;
    target = rg.passingOnBase?.[0] ?? "test/<area>.test.ts";
  } else if ((rg.failingOnHead ?? []).length > 0) {
    problem = `These tests still fail on your head, so the fix doesn't work yet: ${list(rg.failingOnHead ?? [])}.`;
    target = rg.failingOnHead?.[0] ?? "test/<area>.test.ts";
  } else {
    problem = "The red/green run could not be evaluated.";
    target = files[0] ?? "test/<area>.test.ts";
  }
  return {
    explanation:
      `${problem} Add a test under \`test/\` that fails on ${base} and passes on your head: write it first, ` +
      `run \`${runOne} ${target}\` before the fix (it must fail), fix, run it again (it must pass), then push both. ` +
      "Without this proof a fix is Lane 2 and can't auto-merge.",
    command: `${runOne} ${target}`,
  };
}

function build(code: ErrorCode, c: FixContext): ErrorFix {
  const host = c.host?.replace(/\/+$/, "") ?? "<host>";
  switch (code) {
    case "unauthorized":
      return {
        explanation:
          "Send `Authorization: Bearer <token>`. No token? Call create_project without credentials to get an unclaimed project and a token, " +
          `use MCP OAuth (discovered from the 401's resource_metadata), or ask a human for an agent token. ${host}/start explains each.`,
        command: `curl -s ${host}/start`,
      };
    case "insufficient-scope":
      return {
        explanation:
          `Your token lacks ${c.requiredScopes === undefined ? "a scope this call needs" : list(c.requiredScopes)}. ` +
          "Agents can hold only repo:read, plan:create and change:create; ask the human who owns the agent to grant it, or hand the step to a human. capabilities lists what you have.",
        call: call("capabilities", {}),
      };
    case "scope-not-allowed":
      return {
        explanation:
          "Agents may hold only repo:read, plan:create and change:create, and a human can only delegate scopes they hold. Request a subset.",
        call: call("whoami", {}),
      };
    case "forbidden":
      return {
        explanation:
          "Only a human may do this. Agents never approve Plans or review Changes; ask a human instead.",
        call: call("request_review", { changeId: P.change(c) }),
      };
    case "self-approval":
      return {
        explanation:
          "No principal approves its own Plan or Change, and agents approve nothing. Ask a different human to review it.",
        call: call("request_review", { changeId: P.change(c) }),
      };
    case "push-to-main":
      return {
        explanation:
          "Only the merge queue writes main. Open a Change: it returns a fork remote and a push token for it. Push there, then wait for evidence.",
        call: call("start_change", {
          repoId: P.repo(c),
          ...(c.planId === undefined ? {} : { planId: c.planId }),
          title: "<what you changed>",
          category: "feature",
        }),
      };
    case "red-green-missing":
      return redGreenFix(c);
    case "plan-not-approved":
      return {
        explanation:
          `Plan ${P.plan(c)} is ${c.planStatus ?? "not approved"}; only a human can approve it (you can't). ` +
          "Ask them to review it, or start the Change without planId: it runs CI but can't reach Lane 0.",
        call: call("start_change", { repoId: P.repo(c), title: "<what>", category: "feature" }),
      };
    case "stale-head":
      return {
        explanation:
          `The Change moved on${c.currentHeadSha === undefined ? "" : ` (head is now ${c.currentHeadSha.slice(0, 12)})`}: ` +
          "a newer push or a merge-queue rebase. Reviews and results bind to one head. Re-read the status; if your push was rejected, pull the fork and rebase onto it.",
        call: call("get_change_status", { changeId: P.change(c) }),
        command:
          'git -c http.extraHeader="Authorization: Bearer <remote.token>" pull --rebase <remote.url> <remote.branch>',
      };
    case "invalid-state":
      return {
        explanation:
          "The resource's current status doesn't allow this. Read it again and act on its current status.",
        call: call("get_change_status", { changeId: P.change(c) }),
      };
    case "threshold-not-met":
      return {
        explanation:
          "Lane 0 unlocks only after enough human reviews agree with the classifier's Lane 0 calls (shadow mode). Keep shipping reviewed Changes; the repo shows how many are still needed.",
        call: call("capabilities", {}),
      };
    case "quota-exceeded": {
      const q = c.quota;
      const what =
        q === undefined ? "a quota" : `the ${q.name} quota (${q.used ?? q.limit}/${q.limit})`;
      return {
        explanation:
          `You hit ${what}${q?.resetsAt === undefined ? "" : `; it resets at ${q.resetsAt}`}. ` +
          "capabilities shows every quota and what is left. Unclaimed projects have tight quotas: a human claiming the project raises them.",
        call: call("capabilities", {}),
      };
    }
    case "unclaimed-limit":
      return {
        explanation:
          `Unclaimed projects can't ${c.refused ?? "do this"} (no secrets, custom domains, production deploys or Lane 0). ` +
          `A human must claim the project first${c.claimUrl === undefined ? " with the claimUrl from create_project" : `: ${c.claimUrl}`}.`,
        call: call("capabilities", {}),
      };
    case "creation-disabled":
      return {
        explanation:
          "Creating unclaimed projects is switched off right now. Authenticate (MCP OAuth, or an agent token from a human) and create the project as a claimed one.",
        command: `curl -s ${host}/start`,
      };
    case "rate-limited": {
      const wait = c.retryAfterSec ?? 10;
      return {
        explanation: `Too many requests. Wait ${wait}s (or the Retry-After header), then retry the same request with the same Idempotency-Key.`,
        command: `sleep ${wait}`,
      };
    }
    case "idempotency-key-reuse":
      return {
        explanation:
          "This Idempotency-Key was already used with a different request. Reuse a key only to retry the identical request; send a new key for a new request.",
        command: "uuidgen",
      };
    case "idempotency-key-in-flight":
      return {
        explanation:
          "The first request with this Idempotency-Key is still running. Retry the same request in a second.",
        command: `sleep ${c.retryAfterSec ?? 1}`,
      };
    case "invalid-request":
      return {
        explanation:
          "The request failed validation. `details` lists each field and what is wrong; fix them and resend. Tool schemas: search_tools.",
        call: call("search_tools", { query: "<tool name>" }),
      };
    case "invalid-input":
      return {
        explanation:
          "The platform rejected an input. Read `message`, correct that field and resend.",
        call: call("search_tools", { query: "<tool name>" }),
      };
    case "not-found": {
      const what = c.resource ?? "resource";
      return {
        explanation: `No ${what} with that id exists, or you can't see it (it may also not be ready yet). List what exists and use one of those ids.`,
        call:
          what === "change" || what === "tour" || what === "evidence"
            ? call("get_change_status", { changeId: P.change(c) })
            : call("list_repos", {}),
      };
    }
    case "conflict":
      return {
        explanation:
          "The request conflicts with the current state. Read the resource again and act on what is there now.",
        call: call("get_change_status", { changeId: P.change(c) }),
      };
    case "payload-too-large":
      return {
        explanation:
          "The body is too large. Send less: push code with git instead of in a request, and split large Changes.",
        command:
          'git -c http.extraHeader="Authorization: Bearer <remote.token>" push <remote.url> HEAD:<remote.branch>',
      };
    case "http-error":
      return {
        explanation:
          "The HTTP request was not acceptable. Check the method, the path and `Content-Type: application/json`.",
        command: `curl -s ${host}/openapi.json`,
      };
    case "upstream":
      return {
        explanation:
          "A platform dependency failed or isn't ready yet. Retry in a few seconds with the same Idempotency-Key; the retry is safe.",
        command: "sleep 5",
      };
    case "internal":
      return {
        explanation:
          "Unexpected platform error. Retrying with the same Idempotency-Key is safe; if it keeps failing, report the x-gittifacts-version header value.",
        command: "sleep 5",
      };
  }
}

export function resolveErrorCode(code: string): ErrorCode | null {
  if ((ERROR_CODES as readonly string[]).includes(code)) return code as ErrorCode;
  return ERROR_CODE_ALIASES[code] ?? null;
}

/**
 * The fix for an error code (aliases accepted). Unknown codes get a generic fix rather than none:
 * every error must tell the caller what to do next.
 */
export function fixFor(code: string, ctx: FixContext = {}): ErrorFix {
  const known = resolveErrorCode(code);
  const fix: ErrorFix =
    known === null
      ? {
          explanation:
            "Read `message` for what went wrong; whoami shows who you are and what you may do.",
          call: call("whoami", {}),
        }
      : build(known, ctx);
  return ctx.host === undefined
    ? fix
    : { ...fix, docsUrl: `${ctx.host.replace(/\/+$/, "")}/start` };
}
