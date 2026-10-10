/**
 * The palette's commands: what you can do from here, and how an agent would do the same.
 *
 * Every command carries its agent twin (the MCP tool and arguments, which is also the CLI command:
 * `get_evidence` is `gittifacts get-evidence`), or says why there is none. A product rule makes
 * some acts a person's alone (approving, rejecting, the switch-off); those are listed with the
 * rule instead of a twin, so the palette shows the human/agent boundary instead of hiding it.
 * Pure: no DOM, no fetches. Shell supplies the path and the repos it already loaded.
 */
import type { IconId } from "../components/Icon.js";

/** An MCP tool call. `positional` names the argument the CLI takes without a flag. */
export interface Twin {
  tool: string;
  args: Record<string, string>;
  positional?: string;
  /** Required arguments only the agent can supply (a title, an intent): printed as `<title>`. */
  fill?: string[];
}

export type Act =
  | { kind: "go"; href: string; server?: boolean }
  /** A page-level action the current screen handles (`gf:command` event with this name). */
  | { kind: "page"; name: PageCommand }
  | { kind: "theme"; value: "system" | "light" | "dark" };

export type PageCommand = "approve" | "request-changes" | "reject" | "next-stop" | "prev-stop";

export type Group = "This change" | "This plan" | "This repo" | "Go to" | "Preferences";

export interface Command {
  id: string;
  label: string;
  group: Group;
  icon: IconId;
  /** What a person does from the palette; null: agents only (no screen does it). */
  act: Act | null;
  /** What an agent calls; null with `personOnly` set: a product rule keeps it human. */
  twin: Twin | null;
  /** Why only a person may do this (shown in agent mode instead of a twin). */
  personOnly?: string;
  /** Keyboard shortcut on the current screen, as printed keys. */
  keys?: string[];
  /** Extra words to match: synonyms people type. */
  words?: string;
}

export interface RepoRef {
  id: string;
  name: string;
}

const APPROVE_RULE = "Only a person approves, and never their own work. Agents can't approve.";
const KILL_RULE = "Only a person switches a rollout off.";

type Ctx = { kind: "change"; id: string; sub: "" | "evidence" | "rollout" } | { kind: "plan"; id: string } | { kind: "repo"; id: string } | null;

/** The object the current path is about. Mirrors app.tsx routes. */
export function contextOf(path: string): Ctx {
  const p = path.replace(/\/+$/, "");
  let m = /^\/changes\/([^/]+)(?:\/(evidence|rollout))?$/.exec(p);
  if (m?.[1]) return { kind: "change", id: decodeURIComponent(m[1]), sub: (m[2] ?? "") as "" | "evidence" | "rollout" };
  m = /^\/plans\/([^/]+)$/.exec(p);
  if (m?.[1]) return { kind: "plan", id: decodeURIComponent(m[1]) };
  m = /^\/repos\/([^/]+)(?:\/(?:queue|members))?$/.exec(p);
  if (m?.[1]) return { kind: "repo", id: decodeURIComponent(m[1]) };
  return null;
}

function changeCommands(id: string, sub: "" | "evidence" | "rollout"): Command[] {
  const enc = encodeURIComponent(id);
  const twin = (tool: string): Twin => ({ tool, args: { changeId: id }, positional: "changeId" });
  const onTour = sub === "";
  const out: Command[] = [
    { id: "change.status", label: "Walkthrough and status", group: "This change", icon: "route", act: { kind: "go", href: `/changes/${enc}` }, twin: twin("get_change_status"), words: "tour status open" },
    { id: "change.evidence", label: "Evidence", group: "This change", icon: "shield-check", act: { kind: "go", href: `/changes/${enc}/evidence` }, twin: twin("get_evidence"), keys: onTour ? ["E"] : undefined, words: "proof tests signature attestation" },
    { id: "change.rollout", label: "Rollout", group: "This change", icon: "rocket", act: { kind: "go", href: `/changes/${enc}/rollout` }, twin: twin("get_change_status"), words: "deploy flag watch" },
  ];
  if (onTour) {
    out.push(
      { id: "change.approve", label: "Approve…", group: "This change", icon: "check", act: { kind: "page", name: "approve" }, twin: null, personOnly: APPROVE_RULE, keys: ["A"], words: "sign accept lgtm" },
      { id: "change.request", label: "Request changes…", group: "This change", icon: "comment", act: { kind: "page", name: "request-changes" }, twin: null, personOnly: "Only a person reviews. The author agent reads your comment with get_change_status.", words: "review comment" },
      { id: "change.reject", label: "Reject…", group: "This change", icon: "ban", act: { kind: "page", name: "reject" }, twin: null, personOnly: APPROVE_RULE, words: "decline close" },
      { id: "change.next-stop", label: "Next stop", group: "This change", icon: "chevron-down", act: { kind: "page", name: "next-stop" }, twin: null, keys: ["J"] },
      { id: "change.prev-stop", label: "Previous stop", group: "This change", icon: "chevron-up", act: { kind: "page", name: "prev-stop" }, twin: null, keys: ["K"] },
    );
  }
  out.push(
    { id: "change.qa", label: "Run QA in a browser", group: "This change", icon: "test-tube", act: { kind: "go", href: `/changes/${enc}#qa` }, twin: twin("request_qa"), words: "test browser criteria" },
    { id: "change.rerun", label: "Re-run CI", group: "This change", icon: "redo", act: null, twin: twin("rerun_ci"), words: "retry checks pipeline" },
    { id: "change.wait", label: "Wait until it settles", group: "This change", icon: "timer", act: null, twin: twin("wait_for_change"), words: "merged block poll" },
  );
  if (sub === "rollout") {
    out.push({ id: "change.kill", label: "Switch off…", group: "This change", icon: "power", act: { kind: "go", href: `/changes/${enc}/rollout#switch-off` }, twin: null, personOnly: KILL_RULE, words: "kill stop flag revert" });
  }
  return out;
}

function planCommands(id: string): Command[] {
  const twin: Twin = { tool: "get_plan", args: { planId: id }, positional: "planId" };
  return [
    { id: "plan.status", label: "Plan and its approval", group: "This plan", icon: "list-checks", act: { kind: "go", href: `/plans/${encodeURIComponent(id)}` }, twin, words: "intent criteria" },
    { id: "plan.approve", label: "Approve the plan…", group: "This plan", icon: "signature", act: null, twin: null, personOnly: "Only a person approves a plan, and never its author.", words: "sign intent" },
  ];
}

function repoCommands(repo: RepoRef | { id: string; name?: undefined }): Command[] {
  const enc = encodeURIComponent(repo.id);
  const args = { repoId: repo.id };
  return [
    { id: "repo.changes", label: "Changes by lane", group: "This repo", icon: "layers", act: { kind: "go", href: `/repos/${enc}` }, twin: { tool: "list_changes", args, positional: "repoId" }, words: "open review" },
    { id: "repo.queue", label: "Merge queue", group: "This repo", icon: "git-merge", act: { kind: "go", href: `/repos/${enc}/queue` }, twin: { tool: "queue_overview", args, positional: "repoId" }, words: "batches land" },
    { id: "repo.plans", label: "Plans", group: "This repo", icon: "list-checks", act: { kind: "go", href: `/repos/${enc}` }, twin: { tool: "list_plans", args, positional: "repoId" }, words: "intent approval" },
    { id: "repo.members", label: "Members", group: "This repo", icon: "user", act: { kind: "go", href: `/repos/${enc}/members` }, twin: { tool: "list_members", args, positional: "repoId" }, words: "people roles access" },
    { id: "repo.plan", label: "Draft a plan", group: "This repo", icon: "plus", act: null, twin: { tool: "create_plan", args, fill: ["title", "intent", "acceptanceCriteria"] }, words: "new intent" },
    { id: "repo.change", label: "Start a change", group: "This repo", icon: "git-branch", act: null, twin: { tool: "start_change", args, fill: ["title", "category"] }, words: "new branch fork push" },
  ];
}

const NAV: Command[] = [
  { id: "go.dashboard", label: "Dashboard", group: "Go to", icon: "layers", act: { kind: "go", href: "/dashboard" }, twin: { tool: "list_repos", args: {} }, words: "home repos repositories" },
  { id: "go.audit", label: "Audit log", group: "Go to", icon: "scroll-text", act: { kind: "go", href: "/audit" }, twin: null, words: "history events chain" },
  { id: "go.agents", label: "Agents", group: "Go to", icon: "bot", act: { kind: "go", href: "/agents" }, twin: { tool: "whoami", args: {} }, words: "tokens sessions fleet" },
  { id: "go.integrations", label: "Integrations", group: "Go to", icon: "plug", act: { kind: "go", href: "/settings/integrations" }, twin: null, words: "deploy webhooks" },
  { id: "go.github", label: "GitHub", group: "Go to", icon: "git-branch", act: { kind: "go", href: "/settings/github" }, twin: null, words: "app install" },
  { id: "go.docs", label: "Docs", group: "Go to", icon: "file-text", act: { kind: "go", href: "/docs", server: true }, twin: { tool: "search_tools", args: {} }, words: "help guide" },
];

const PREFS: Command[] = (["system", "light", "dark"] as const).map((value) => ({
  id: `theme.${value}`,
  label: value === "system" ? "Theme: follow the system" : `Theme: ${value}`,
  group: "Preferences" as const,
  icon: value === "system" ? ("monitor" as const) : value === "light" ? ("sun" as const) : ("moon" as const),
  act: { kind: "theme" as const, value },
  twin: null,
  words: "appearance night mode",
}));

/** Every command for this screen: the object in view first, then its repo, then places. */
export function commandsFor(path: string, repos: RepoRef[]): Command[] {
  const ctx = contextOf(path);
  const here: Command[] = [];
  if (ctx?.kind === "change") here.push(...changeCommands(ctx.id, ctx.sub));
  if (ctx?.kind === "plan") here.push(...planCommands(ctx.id));
  if (ctx?.kind === "repo") here.push(...repoCommands(repos.find((r) => r.id === ctx.id) ?? { id: ctx.id }));
  const places = repos.map<Command>((r) => ({
    id: `go.repo.${r.id}`,
    label: r.name,
    group: "Go to",
    icon: "git-branch",
    act: { kind: "go", href: `/repos/${encodeURIComponent(r.id)}` },
    twin: { tool: "list_changes", args: { repoId: r.id }, positional: "repoId" },
    words: "repository repo",
  }));
  return [...here, ...NAV, ...places, ...PREFS];
}

export type Mode = "me" | "agent";

/**
 * What each mode lists. Yourself: what a screen can do, minus the screen you're on. For an agent:
 * every command with a twin, plus the person-only ones (with their rule), so the boundary shows.
 */
export function forMode(commands: Command[], mode: Mode, path: string): Command[] {
  if (mode === "agent") return commands.filter((c) => c.twin !== null || c.personOnly !== undefined);
  return commands.filter((c) => c.act !== null && !(c.act.kind === "go" && !c.act.href.includes("#") && c.act.href === path));
}

/** Ranks by query: every word must appear; label prefixes first, then label words, then the rest. */
export function match(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands;
  const scored: { c: Command; score: number; i: number }[] = [];
  commands.forEach((c, i) => {
    const label = c.label.toLowerCase();
    const hay = `${label} ${c.group.toLowerCase()} ${c.words ?? ""} ${c.twin?.tool ?? ""} ${c.twin ? commandName(c.twin.tool) : ""}`;
    if (!words.every((w) => hay.includes(w))) return;
    const first = words[0] ?? "";
    const score = label.startsWith(first) ? 0 : label.split(/\W+/).some((t) => t.startsWith(first)) ? 1 : 2;
    scored.push({ c, score, i });
  });
  return scored.sort((x, y) => x.score - y.score || x.i - y.i).map((x) => x.c);
}

/** `get_change_status` → `get-change-status`, as the CLI names it. */
export function commandName(tool: string): string {
  return tool.replaceAll("_", "-");
}

/** `changeId` → `--change-id`. */
function flag(property: string): string {
  return `--${property.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
}

function quoteArg(v: string): string {
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`;
}

/** The MCP call as an agent would make it: `get_evidence({ "changeId": "chg_1" })`. */
export function mcpText(t: Twin): string {
  const entries = [...Object.entries(t.args), ...(t.fill ?? []).map((k) => [k, `<${k}>`] as const)];
  if (entries.length === 0) return `${t.tool}()`;
  return `${t.tool}({ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} })`;
}

/** The CLI arguments for the same call: `get-evidence chg_1`, `create-plan --repo-id r1 --title <title>`. */
export function cliArgs(t: Twin): string {
  const parts = [commandName(t.tool)];
  const pos = t.positional;
  if (pos && t.args[pos] !== undefined) parts.push(quoteArg(t.args[pos]));
  for (const [k, v] of Object.entries(t.args)) if (k !== pos) parts.push(flag(k), quoteArg(v));
  for (const k of t.fill ?? []) parts.push(flag(k), `<${k}>`);
  return parts.join(" ");
}
