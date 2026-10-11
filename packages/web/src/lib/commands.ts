/**
 * The palette's commands: what you can do from here, and how an agent would do the same.
 *
 * Every command carries exactly one of three (the Twin Rule, DESIGN.md): its agent twin (the MCP
 * tool and arguments, which is also the CLI command: `get_evidence` is `gittifacts get-evidence`);
 * a `personOnly` rule (approving, rejecting, the switch-off, policy, membership, agents); or a
 * `twinless` reason (navigation only, or no tool yet). So the palette shows the human/agent
 * boundary instead of hiding it.
 * Pure: no DOM, no fetches. The palette supplies the path, the repos the sidebar loaded and the
 * objects it fetched for this opening.
 */
import { GITHUB_SURFACES } from "@app/domain/surfaces";
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

export type PageCommand = "approve" | "request-changes" | "reject" | "next-stop" | "prev-stop" | "next-change";

export type Group = "This change" | "This plan" | "This repo" | "Your agents" | "Open" | "Go to" | "Preferences";

export interface Command {
  id: string;
  label: string;
  group: Group;
  icon: IconId;
  /** What a person does from the palette; null: agents only (no screen does it). */
  act: Act | null;
  /** What an agent calls; null with `personOnly` or `twinless` set. */
  twin: Twin | null;
  /** Why only a person may do this (shown in agent mode instead of a twin). */
  personOnly?: string;
  /** Why no agent call fits: navigation only, or no tool yet (said as such). */
  twinless?: string;
  /** Keyboard shortcut on the current screen, as printed keys. */
  keys?: string[];
  /** Extra words to match: synonyms people type, an object's id. */
  words?: string;
  /** A quiet second line of identity on object rows (repo, status). */
  meta?: string;
}

export interface RepoRef {
  id: string;
  name: string;
  /** GitHub mode: GitHub merges, so there is no merge queue here. */
  hosted?: boolean;
}

/** Objects the palette can open: fetched once per opening, from the lists the screens use. */
export interface PaletteObjects {
  changes: { id: string; title: string; repoId: string; status: string }[];
  plans: { id: string; title: string; repoId: string; status: string; authorId?: string }[];
  agents: { id: string; name: string }[];
}

const APPROVE_RULE = "Only a person approves, and never their own work. Agents can't approve.";
const KILL_RULE = "Only a person switches a rollout off.";
const IMPORT_RULE = "Only a person imports a private repo: the one-time push grant goes to its signed-in owner. Agents import public repos with create_project({ from }).";
const PICK_RULE = "Only a person approves a Change, and picking an attempt approves it. Agents never approve.";
const AGENTS_RULE = "Only a person creates, revokes or pauses agents.";
const NAV_ONLY = "Navigation only: a key for the reader, not an act.";

/** The repo screens: changes, merge queue, members, mission control. */
type RepoSub = "" | "queue" | "members" | "mission";

export type Ctx =
  | { kind: "change"; id: string; sub: "" | "evidence" | "rollout" }
  | { kind: "plan"; id: string }
  | { kind: "repo"; id: string; sub: RepoSub }
  | { kind: "agents" }
  | { kind: "audit" }
  | null;

/** The object the current path is about. Mirrors app.tsx routes. */
export function contextOf(path: string): Ctx {
  const p = path.replace(/\/+$/, "");
  let m = /^\/changes\/([^/]+)(?:\/(evidence|rollout))?$/.exec(p);
  if (m?.[1]) return { kind: "change", id: decodeURIComponent(m[1]), sub: (m[2] ?? "") as "" | "evidence" | "rollout" };
  m = /^\/plans\/([^/]+)$/.exec(p);
  if (m?.[1]) return { kind: "plan", id: decodeURIComponent(m[1]) };
  m = /^\/repos\/([^/]+)(?:\/(queue|members|mission))?$/.exec(p);
  if (m?.[1]) return { kind: "repo", id: decodeURIComponent(m[1]), sub: (m[2] ?? "") as RepoSub };
  if (p === "/agents") return { kind: "agents" };
  if (p === "/audit") return { kind: "audit" };
  return null;
}

/** What the palette knows about the change or plan in view (from its objects), when it knows. */
export interface ChangeHere {
  status?: string;
  /** The viewer wrote it (a plan's author may withdraw it while it is a draft). */
  mine?: boolean;
  /** The change's repo, when known (the next change to review is in the same repo). */
  repoId?: string;
}

function changeCommands(id: string, sub: "" | "evidence" | "rollout", here: ChangeHere): Command[] {
  const enc = encodeURIComponent(id);
  const twin = (tool: string): Twin => ({ tool, args: { changeId: id }, positional: "changeId" });
  const onTour = sub === "";
  const out: Command[] = [
    { id: "change.tour", label: "Walkthrough", group: "This change", icon: "route", act: { kind: "go", href: `/changes/${enc}` }, twin: twin("get_tour"), words: "tour stops open review" },
    { id: "change.status", label: "Status, lane and reviews", group: "This change", icon: "info", act: null, twin: twin("get_change_status"), words: "state runs ci comments" },
    { id: "change.evidence", label: "Evidence", group: "This change", icon: "shield-check", act: { kind: "go", href: `/changes/${enc}/evidence` }, twin: twin("get_evidence"), keys: onTour ? ["E"] : undefined, words: "proof tests signature attestation" },
    { id: "change.rollout", label: "Rollout", group: "This change", icon: "rocket", act: { kind: "go", href: `/changes/${enc}/rollout` }, twin: twin("get_rollout"), words: "deploy flag watch stages error rate" },
  ];
  if (onTour) {
    out.push(
      { id: "change.approve", label: "Approve…", group: "This change", icon: "check", act: { kind: "page", name: "approve" }, twin: null, personOnly: APPROVE_RULE, keys: ["A"], words: "sign accept lgtm" },
      { id: "change.request", label: "Request changes…", group: "This change", icon: "comment", act: { kind: "page", name: "request-changes" }, twin: null, personOnly: "Only a person reviews. The author agent reads your comment with get_change_status.", words: "review comment" },
      { id: "change.reject", label: "Reject…", group: "This change", icon: "ban", act: { kind: "page", name: "reject" }, twin: null, personOnly: APPROVE_RULE, words: "decline" },
      { id: "change.next-stop", label: "Next stop", group: "This change", icon: "chevron-down", act: { kind: "page", name: "next-stop" }, twin: null, twinless: NAV_ONLY, keys: ["J"] },
      { id: "change.prev-stop", label: "Previous stop", group: "This change", icon: "chevron-up", act: { kind: "page", name: "prev-stop" }, twin: null, twinless: NAV_ONLY, keys: ["K"] },
    );
    // Once decided, the decision panel offers the next change waiting in the repo; N opens it.
    if (here.repoId && here.status !== undefined && here.status !== "awaiting-review") {
      out.push({ id: "change.next-change", label: "Next change to review", group: "This change", icon: "chevron-right", act: { kind: "page", name: "next-change" }, twin: { tool: "list_changes", args: { repoId: here.repoId, status: "awaiting-review" } }, keys: ["N"], words: "queue inbox waiting following" });
    }
  }
  out.push(
    { id: "change.qa", label: "Run QA in a browser", group: "This change", icon: "test-tube", act: { kind: "go", href: `/changes/${enc}#qa` }, twin: twin("request_qa"), words: "test browser criteria" },
    { id: "change.qa-result", label: "Read the QA results", group: "This change", icon: "list-checks", act: null, twin: twin("get_qa"), words: "qa verdict criteria" },
    { id: "change.request-review", label: "Ask for a review", group: "This change", icon: "send", act: null, twin: twin("request_review"), words: "ready hand off reviewer" },
    { id: "change.rerun", label: "Re-run CI", group: "This change", icon: "redo", act: null, twin: twin("rerun_ci"), words: "retry checks pipeline" },
    { id: "change.wait", label: "Wait until it merges", group: "This change", icon: "timer", act: null, twin: { tool: "wait_for_change", args: { changeId: id, until: "merged" }, positional: "changeId" }, words: "merged block poll settle" },
    { id: "change.queue-status", label: "Where it is in the merge queue", group: "This change", icon: "git-merge", act: null, twin: twin("queue_status"), words: "queue position eta batch" },
  );
  if (here.status === "queued") {
    out.push(
      { id: "change.dequeue", label: "Pull it from the merge queue", group: "This change", icon: "undo", act: null, twin: twin("dequeue"), words: "dequeue remove queue" },
      { id: "change.reprioritize", label: "Move it up or down the merge queue", group: "This change", icon: "list-ordered", act: null, twin: { tool: "reprioritize", args: { changeId: id }, positional: "changeId", fill: ["priority"] }, words: "priority bump queue" },
    );
  }
  out.push({ id: "change.trail", label: "Its audit trail", group: "This change", icon: "scroll-text", act: { kind: "go", href: `/audit?subject=${encodeURIComponent(`change:${id}`)}` }, twin: { tool: "list_audit_events", args: { subject: `change:${id}` } }, words: "history events audit" });
  out.push({ id: "change.close", label: "Close the change", group: "This change", icon: "archive", act: { kind: "go", href: `/changes/${enc}#close` }, twin: twin("close_change"), words: "abandon stale drop" });
  if (sub === "rollout") {
    out.push(
      { id: "change.issues", label: "Production issues", group: "This change", icon: "triangle-alert", act: null, twin: twin("list_issues_for_change"), words: "errors incidents sentry" },
      { id: "change.kill", label: "Switch off…", group: "This change", icon: "power", act: { kind: "go", href: `/changes/${enc}/rollout#switch-off` }, twin: null, personOnly: KILL_RULE, words: "kill stop flag revert" },
    );
  }
  return out;
}

function planCommands(id: string, here: ChangeHere): Command[] {
  const enc = encodeURIComponent(id);
  const twin: Twin = { tool: "get_plan", args: { planId: id }, positional: "planId" };
  const sign: Act = { kind: "go", href: `/plans/${enc}#sign` };
  return [
    { id: "plan.status", label: "Plan and its approval", group: "This plan", icon: "list-checks", act: { kind: "go", href: `/plans/${enc}` }, twin, words: "intent criteria" },
    { id: "plan.approve", label: "Approve the plan…", group: "This plan", icon: "signature", act: sign, twin: null, personOnly: "Only a person approves a plan, and never its author.", words: "sign intent" },
    { id: "plan.reject", label: "Reject the plan…", group: "This plan", icon: "ban", act: sign, twin: null, personOnly: "Only a person rejects a plan, and says why.", words: "decline intent" },
    { id: "plan.attempts", label: "Compare attempts", group: "This plan", icon: "list-ordered", act: { kind: "go", href: `/plans/${enc}#attempts` }, twin: { tool: "compare_attempts", args: { planId: id }, positional: "planId" }, words: "rank agents changes evidence best recommended" },
    { id: "plan.pick", label: "Pick an attempt…", group: "This plan", icon: "check", act: { kind: "go", href: `/plans/${enc}#attempts` }, twin: null, personOnly: PICK_RULE, words: "choose approve winner supersede" },
    // A person runs it only where it applies: their own draft (the plan page confirms on #withdraw).
    { id: "plan.withdraw", label: "Withdraw your draft plan…", group: "This plan", icon: "undo", act: here.status === "draft" && here.mine ? { kind: "go", href: `/plans/${enc}#withdraw` } : null, twin: { tool: "withdraw_plan", args: { planId: id }, positional: "planId" }, words: "cancel retract author" },
  ];
}

function repoCommands(repo: RepoRef | { id: string; name?: undefined; hosted?: undefined }, sub: RepoSub): Command[] {
  const enc = encodeURIComponent(repo.id);
  const args = { repoId: repo.id };
  const out: Command[] = [
    { id: "repo.changes", label: "Changes by lane", group: "This repo", icon: "layers", act: { kind: "go", href: `/repos/${enc}` }, twin: { tool: "list_changes", args, positional: "repoId" }, words: "open review" },
    { id: "repo.mission", label: "Mission control", group: "This repo", icon: "bot", act: { kind: "go", href: `/repos/${enc}/mission` }, twin: { tool: "list_changes", args, positional: "repoId" }, words: "agents live board fleet stage" },
  ];
  // GitHub mode: GitHub merges, and the repo page offers no queue, so neither does the palette.
  if (!repo.hosted) {
    out.push({ id: "repo.queue", label: "Merge queue", group: "This repo", icon: "git-merge", act: { kind: "go", href: `/repos/${enc}/queue` }, twin: { tool: "queue_overview", args, positional: "repoId" }, words: "batches land" });
  }
  out.push(
    { id: "repo.plans", label: "Plans", group: "This repo", icon: "list-checks", act: { kind: "go", href: `/repos/${enc}#all-plans` }, twin: { tool: "list_plans", args, positional: "repoId" }, words: "intent approval" },
    { id: "repo.members", label: "Members", group: "This repo", icon: "user", act: { kind: "go", href: `/repos/${enc}/members` }, twin: { tool: "list_members", args, positional: "repoId" }, words: "people roles access" },
    { id: "repo.membership", label: "Add, remove or change a member…", group: "This repo", icon: "user", act: sub === "members" ? null : { kind: "go", href: `/repos/${enc}/members` }, twin: null, personOnly: "Only a person manages membership.", words: "invite role remove leave" },
    { id: "repo.lane0", label: "Turn auto-merge (Lane 0) on or off…", group: "This repo", icon: "shield-check", act: { kind: "go", href: `/repos/${enc}#lane0-title` }, twin: null, personOnly: "Only a person changes policy, such as auto-merge.", words: "policy lane 0 automerge" },
    { id: "repo.plan", label: "What should change?", group: "This repo", icon: "plus", act: { kind: "go", href: `/repos/${enc}#intent` }, twin: { tool: "create_plan", args, fill: ["title", "intent", "acceptanceCriteria"] }, words: "draft a plan new intent start work ask agent" },
    { id: "repo.change", label: "Start a change", group: "This repo", icon: "git-branch", act: null, twin: { tool: "start_change", args, fill: ["title", "category"] }, words: "new branch fork push" },
  );
  // The queue's own controls are a person's; the queue screen holds them (owners only).
  if (sub !== "members" && !repo.hosted) {
    const queue: Act = { kind: "go", href: `/repos/${enc}/queue` };
    const rule = "Only a person freezes, thaws or resumes the merge queue.";
    out.push(
      { id: "queue.freeze", label: "Freeze the queue…", group: "This repo", icon: "pause", act: queue, twin: null, personOnly: rule, words: "halt stop pause incident" },
      { id: "queue.thaw", label: "Thaw the queue…", group: "This repo", icon: "redo", act: queue, twin: null, personOnly: rule, words: "unfreeze open" },
      { id: "queue.resume", label: "Resume the queue…", group: "This repo", icon: "redo", act: queue, twin: null, personOnly: rule, words: "halted restart continue" },
    );
  }
  return out;
}

function agentsCommands(): Command[] {
  return [
    { id: "agents.add", label: "Add an agent…", group: "Your agents", icon: "plus", act: null, twin: null, personOnly: AGENTS_RULE, words: "token connect new" },
    { id: "agents.revoke", label: "Revoke an agent…", group: "Your agents", icon: "ban", act: null, twin: null, personOnly: AGENTS_RULE, words: "remove disconnect token" },
  ];
}

const ALL_NAV: Command[] = [
  { id: "go.dashboard", label: "Dashboard", group: "Go to", icon: "layers", act: { kind: "go", href: "/dashboard" }, twin: { tool: "list_repos", args: {} }, words: "home repos repositories" },
  { id: "go.import", label: "Import a private repo…", group: "Go to", icon: "upload", act: { kind: "go", href: "/dashboard#import" }, twin: null, personOnly: IMPORT_RULE, words: "push history migrate new repository project" },
  { id: "go.audit", label: "Audit log", group: "Go to", icon: "scroll-text", act: { kind: "go", href: "/audit" }, twin: { tool: "list_audit_events", args: {} }, words: "history events chain trail" },
  { id: "go.agents", label: "Agents", group: "Go to", icon: "bot", act: { kind: "go", href: "/agents" }, twin: null, personOnly: AGENTS_RULE, words: "tokens sessions fleet" },
  { id: "go.whoami", label: "Who am I", group: "Go to", icon: "bot", act: null, twin: { tool: "whoami", args: {} }, words: "identity scopes self me" },
  { id: "go.integrations", label: "Integrations", group: "Go to", icon: "plug", act: { kind: "go", href: "/settings/integrations" }, twin: null, personOnly: "Only a person installs an integration or grants it access.", words: "deploy webhooks" },
  { id: "go.github", label: "GitHub", group: "Go to", icon: "git-branch", act: { kind: "go", href: "/settings/github" }, twin: null, personOnly: "Only a person connects GitHub.", words: "app install" },
  { id: "go.docs", label: "Docs", group: "Go to", icon: "file-text", act: { kind: "go", href: "/docs", server: true }, twin: { tool: "search_tools", args: {}, fill: ["query"] }, words: "help guide" },
];
/** "GitHub" leaves the palette while GitHub surfaces are off (@app/domain/surfaces). */
const NAV = ALL_NAV.filter((c) => GITHUB_SURFACES || c.id !== "go.github");

const PREFS: Command[] = (["system", "light", "dark"] as const).map((value) => ({
  id: `theme.${value}`,
  label: value === "system" ? "Theme: follow the system" : `Theme: ${value}`,
  group: "Preferences" as const,
  icon: value === "system" ? ("monitor" as const) : value === "light" ? ("sun" as const) : ("moon" as const),
  act: { kind: "theme" as const, value },
  twin: null,
  twinless: "A reader's setting: agents have no theme.",
  words: "appearance night mode",
}));

const STATUS_WORDS: Record<string, string> = {
  "awaiting-push": "Waiting for a push",
  running: "CI running",
  failing: "Failing",
  "awaiting-review": "Waiting for review",
  approved: "Approved",
  queued: "In the queue",
  "rolling-out": "Rolling out",
  draft: "Waiting for approval",
};

/** The objects the palette fetched, as rows that open them. Only listed while you type. */
export function objectCommands(objects: PaletteObjects, repos: RepoRef[]): Command[] {
  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
  const meta = (repoId: string, status: string) => [repoName(repoId), STATUS_WORDS[status]].filter(Boolean).join(" · ");
  return [
    ...objects.changes.map<Command>((c) => ({
      id: `open.change.${c.id}`,
      label: c.title,
      group: "Open",
      icon: "git-branch",
      act: { kind: "go", href: `/changes/${encodeURIComponent(c.id)}` },
      twin: { tool: "get_change_status", args: { changeId: c.id }, positional: "changeId" },
      words: `${c.id} change ${repoName(c.repoId)}`,
      meta: meta(c.repoId, c.status),
    })),
    ...objects.plans.map<Command>((p) => ({
      id: `open.plan.${p.id}`,
      label: p.title,
      group: "Open",
      icon: "list-checks",
      act: { kind: "go", href: `/plans/${encodeURIComponent(p.id)}` },
      twin: { tool: "get_plan", args: { planId: p.id }, positional: "planId" },
      words: `${p.id} plan ${repoName(p.repoId)}`,
      meta: meta(p.repoId, p.status),
    })),
    ...objects.agents.map<Command>((a) => ({
      id: `open.agent.${a.id}`,
      label: a.name,
      group: "Open",
      icon: "bot",
      act: { kind: "go", href: "/agents" },
      twin: null,
      personOnly: AGENTS_RULE,
      words: `${a.id} agent`,
      meta: "Agent",
    })),
  ];
}

/**
 * A pasted id (`chg_…`, `plan_…`, `repo_…`) or an app URL, as one row that goes straight there.
 * The objects already loaded name it better; this covers ids the palette hasn't fetched.
 */
export function jumpCommand(query: string, origin: string): Command | null {
  const q = query.trim();
  let path: string | null = null;
  if (q.startsWith(`${origin}/`)) path = q.slice(origin.length);
  else if (/^\/(changes|plans|repos|audit|agents|dashboard|settings)\b/.test(q)) path = q;
  if (path) {
    return { id: "jump.path", label: `Go to ${path}`, group: "Open", icon: "arrow-up-right", act: { kind: "go", href: path }, twin: null, twinless: "Navigation only: an address to open.", words: q.toLowerCase() };
  }
  const enc = encodeURIComponent(q);
  // The platform's ids are 20 characters of [0-9a-z] with no kind in them: offer the likely two.
  if (/^[0-9a-z]{20}$/.test(q)) return { id: "jump.change", label: `Open change ${q}`, group: "Open", icon: "git-branch", act: { kind: "go", href: `/changes/${enc}` }, twin: { tool: "get_change_status", args: { changeId: q }, positional: "changeId" }, words: q };
  const m = /^(chg|plan|repo)_[\w-]+$/.exec(q);
  if (!m) return null;
  if (m[1] === "chg") return { id: "jump.change", label: `Open change ${q}`, group: "Open", icon: "git-branch", act: { kind: "go", href: `/changes/${enc}` }, twin: { tool: "get_change_status", args: { changeId: q }, positional: "changeId" }, words: q.toLowerCase() };
  if (m[1] === "plan") return { id: "jump.plan", label: `Open plan ${q}`, group: "Open", icon: "list-checks", act: { kind: "go", href: `/plans/${enc}` }, twin: { tool: "get_plan", args: { planId: q }, positional: "planId" }, words: q.toLowerCase() };
  return { id: "jump.repo", label: `Open repository ${q}`, group: "Open", icon: "layers", act: { kind: "go", href: `/repos/${enc}` }, twin: { tool: "list_changes", args: { repoId: q }, positional: "repoId" }, words: q.toLowerCase() };
}

/** Every command for this screen: the object in view first, then its repo, then places. */
export function commandsFor(path: string, repos: RepoRef[], here: ChangeHere = {}): Command[] {
  const ctx = contextOf(path);
  const cmds: Command[] = [];
  if (ctx?.kind === "change") cmds.push(...changeCommands(ctx.id, ctx.sub, here));
  if (ctx?.kind === "plan") cmds.push(...planCommands(ctx.id, here));
  if (ctx?.kind === "repo") cmds.push(...repoCommands(repos.find((r) => r.id === ctx.id) ?? { id: ctx.id }, ctx.sub));
  if (ctx?.kind === "agents") cmds.push(...agentsCommands());
  const places = repos.map<Command>((r) => ({
    id: `go.repo.${r.id}`,
    label: r.name,
    group: "Go to",
    icon: "git-branch",
    act: { kind: "go", href: `/repos/${encodeURIComponent(r.id)}` },
    twin: { tool: "list_changes", args: { repoId: r.id }, positional: "repoId" },
    words: `repository repo ${r.id}`,
  }));
  return [...cmds, ...NAV, ...places, ...PREFS];
}

export type Mode = "me" | "agent";

/**
 * What each mode lists. Yourself: what a screen can do, minus the screen you're on. For an agent:
 * every command with a twin, the person-only ones (with their rule) and the places no tool reads
 * yet (with that reason), so the boundary shows. A reader's own controls stay out.
 */
export function forMode(commands: Command[], mode: Mode, path: string): Command[] {
  if (mode === "agent") return commands.filter((c) => c.twin !== null || c.personOnly !== undefined || (c.twinless !== undefined && c.act?.kind === "go"));
  return commands.filter((c) => c.act !== null && !(c.act.kind === "go" && !c.act.href.includes("#") && c.act.href === path));
}

/**
 * Ranks by query: every word must appear; label prefixes first, then label words, then the rest.
 * Rows stay with their group (one heading each), and the group holding the best match leads.
 */
export function match(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands;
  const scored: { c: Command; score: number; i: number }[] = [];
  commands.forEach((c, i) => {
    const label = c.label.toLowerCase();
    const hay = `${label} ${c.group.toLowerCase()} ${c.words ?? ""} ${(c.meta ?? "").toLowerCase()} ${c.twin?.tool ?? ""} ${c.twin ? commandName(c.twin.tool) : ""}`;
    if (!words.every((w) => hay.includes(w))) return;
    const first = words[0] ?? "";
    const score = label.startsWith(first) ? 0 : label.split(/\W+/).some((t) => t.startsWith(first)) ? 1 : 2;
    scored.push({ c, score, i });
  });
  const best = new Map<Group, { score: number; i: number }>();
  for (const s of scored) {
    const b = best.get(s.c.group);
    if (!b || s.score < b.score || (s.score === b.score && s.i < b.i)) best.set(s.c.group, { score: s.score, i: s.i });
  }
  const rank = (s: { c: Command }) => best.get(s.c.group) ?? { score: 0, i: 0 };
  return scored
    .sort((x, y) => rank(x).score - rank(y).score || rank(x).i - rank(y).i || x.score - y.score || x.i - y.i)
    .map((x) => x.c);
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
