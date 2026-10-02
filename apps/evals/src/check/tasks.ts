/**
 * Deterministic task checkers. They read the platform with the eval-admin credential and decide
 * from platform state only, never from what the agent says it did:
 *
 * - t1: a project created during the run whose preview serves the current time (HTTP 200 + a
 *   current ISO timestamp). TTFG = first green − run start.
 * - t2: a project imported from the fixture during the run + a Change whose evidence carries a
 *   red/green item with verdict `proven` (signature verified).
 * - t3: a Change created during the run with `public-api` evidence classified `additive`, routed
 *   to Lane 1, with a tour.
 * - t4: t1's checks + zero `shell` calls. Whether `open_workspace` was used is recorded but does
 *   not gate: the workers-api template already satisfies task 1, so a remote-only agent may
 *   legitimately finish without editing anything (lead decision 2026-10-02).
 *
 * Attribution: only ids harvested from this run's own tool output count (never "any repo created
 * in the window"), so parallel runs can't pass on each other's work.
 */
import type { Harvest } from "../agent/tool-outcome.js";
import type { CheckItem } from "../results.js";
import type { TaskId } from "../tasks.js";
import type { ProbeResult } from "../tools/probe.js";
import type { ApiChange, ApiEvidence, ApiRepo, EvidenceItem, PlatformApi } from "./api.js";

export interface CheckInput {
  task: TaskId;
  startedAt: number;
  endedAt: number;
  harvest: Harvest;
  /** First green preview the run's probes saw, if any. */
  firstGreen: { url: string; at: number } | null;
  toolCounts: Record<string, number>;
  /** Every mcp_call: which MCP tool, and whether it failed. */
  mcpCalls: { name: string; isError: boolean }[];
  importRepoUrl: string | null;
  previewSuffix: string;
}

export interface CheckDeps {
  api: PlatformApi;
  probe: (url: string) => Promise<ProbeResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface CheckOutput {
  success: boolean;
  checks: CheckItem[];
  ttfgMs: number | null;
  ttfgSource: "probe" | "evidence" | "check" | null;
  /** Projects and Changes the checker attributed to the run. */
  repoIds: string[];
  changeIds: string[];
}

/** Repos created before the run started (minus clock slack) are not the run's work. */
const CLOCK_SLACK_MS = 60_000;

export function normalizeRepoUrl(u: string): string {
  try {
    const url = new URL(u.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .toLowerCase();
    return `${host}${path}`;
  } catch {
    return u.trim().toLowerCase();
  }
}

function field(item: EvidenceItem | undefined, key: string): unknown {
  return item ? (item as Record<string, unknown>)[key] : undefined;
}

export interface RunState {
  repos: ApiRepo[];
  changes: (ApiChange & { authorKind?: string })[];
  evidence: Map<string, ApiEvidence | null>;
}

/** Loads the run's projects (created during the run) and all their Changes, with evidence. */
export async function loadRunState(input: CheckInput, api: PlatformApi): Promise<RunState> {
  const repoIds = new Set(input.harvest.repoIds);
  for (const id of input.harvest.changeIds) {
    const c = await api.change(id).catch(() => null);
    if (c) repoIds.add(c.change.repoId);
  }
  const repos: ApiRepo[] = [];
  for (const id of repoIds) {
    const r = await api.repo(id).catch(() => null);
    if (r && Date.parse(r.createdAt) >= input.startedAt - CLOCK_SLACK_MS) repos.push(r);
  }
  const changes: RunState["changes"] = [];
  for (const r of repos) changes.push(...(await api.changes(r.id)));
  const evidence = new Map<string, ApiEvidence | null>();
  for (const c of changes) evidence.set(c.id, await api.evidence(c.id).catch(() => null));
  return { repos, changes, evidence };
}

export function itemOf(ev: ApiEvidence | null | undefined, kind: string): EvidenceItem | undefined {
  return ev?.evidence.items.find((i) => i.kind === kind);
}

export function isAgentChange(c: { id: string; authorKind?: string }): boolean {
  return !c.id.startsWith("bs-") && c.authorKind !== "system";
}

interface PreviewVerdict {
  item: CheckItem;
  ttfgMs: number | null;
  ttfgSource: CheckOutput["ttfgSource"];
}

/** t1/t4: some Change of the run serves the current time on its preview. */
async function checkPreview(
  state: RunState,
  input: CheckInput,
  deps: CheckDeps,
): Promise<PreviewVerdict> {
  const urls: string[] = [];
  const signedAt = new Map<string, number>();
  for (const c of state.changes) {
    const ev = state.evidence.get(c.id);
    const p = itemOf(ev, "preview");
    const url = field(p, "url");
    if (p?.status === "ok" && typeof url === "string") {
      urls.push(url);
      const at = Date.parse(ev?.evidence.attestation?.signedAt ?? "");
      if (Number.isFinite(at)) signedAt.set(url, at);
    }
    urls.push(`https://p-${c.id}${input.previewSuffix}`.toLowerCase());
  }
  if (state.repos.length > 0) urls.push(...input.harvest.previewUrls);
  const unique = [...new Set(urls)];
  const tried: string[] = [];
  for (const url of unique) {
    const r = await deps.probe(url);
    tried.push(`${url}: ${r.detail}`);
    if (!r.green) continue;
    const candidates: { ms: number; source: "probe" | "evidence" | "check" }[] = [
      { ms: r.at - input.startedAt, source: "check" },
    ];
    if (input.firstGreen)
      candidates.push({ ms: input.firstGreen.at - input.startedAt, source: "probe" });
    const ev = signedAt.get(url);
    if (ev !== undefined) candidates.push({ ms: ev - input.startedAt, source: "evidence" });
    const best = candidates.filter((c) => c.ms >= 0).sort((a, b) => a.ms - b.ms)[0];
    return {
      item: { name: "preview-serves-time", pass: true, detail: `${url} ${r.detail}` },
      ttfgMs: best?.ms ?? null,
      ttfgSource: best?.source ?? null,
    };
  }
  return {
    item: {
      name: "preview-serves-time",
      pass: false,
      detail: tried.length ? tried.slice(0, 6).join("; ") : "no preview URL for the run's Changes",
    },
    ttfgMs: null,
    ttfgSource: null,
  };
}

/** t2: imported from the fixture, and a fix Change with red/green proof. */
function checkImportFix(state: RunState, input: CheckInput): CheckItem[] {
  const want = input.importRepoUrl ? normalizeRepoUrl(input.importRepoUrl) : null;
  const imported = state.repos.filter(
    (r) => want !== null && !!r.importedFrom && normalizeRepoUrl(r.importedFrom) === want,
  );
  const items: CheckItem[] = [
    {
      name: "imported",
      pass: imported.length > 0,
      detail: imported.length
        ? `repo ${imported.map((r) => r.id).join(", ")} imported from ${input.importRepoUrl}`
        : `no project of the run was imported from ${input.importRepoUrl ?? "(unset)"}`,
    },
  ];
  const ids = new Set(imported.map((r) => r.id));
  const proofs = state.changes
    .filter((c) => ids.has(c.repoId) && isAgentChange(c))
    .map((c) => ({
      c,
      ev: state.evidence.get(c.id),
      rg: itemOf(state.evidence.get(c.id), "red-green"),
    }));
  const proven = proofs.find(
    (p) =>
      p.rg?.status === "ok" &&
      field(p.rg, "verdict") === "proven" &&
      p.ev?.verification.ok === true,
  );
  items.push({
    name: "red-green-proven",
    pass: proven !== undefined,
    detail: proven
      ? `change ${proven.c.id}: red/green proven, evidence signature verified`
      : proofs.length
        ? proofs
            .map(
              (p) =>
                `${p.c.id}: ${p.rg ? `${p.rg.status}/${String(field(p.rg, "verdict"))}` : "no red-green item"}`,
            )
            .join("; ")
        : "no agent Change in the imported project",
  });
  return items;
}

/** t3: one Change with additive public-api evidence, Lane 1, and a tour. */
async function checkLibraryApi(
  state: RunState,
  input: CheckInput,
  api: PlatformApi,
): Promise<CheckItem[]> {
  let best: { id: string; items: CheckItem[]; score: number } | null = null;
  for (const c of state.changes) {
    if (!isAgentChange(c) || Date.parse(c.createdAt) < input.startedAt - CLOCK_SLACK_MS) continue;
    const ev = state.evidence.get(c.id);
    const pa = itemOf(ev, "public-api");
    const additive =
      pa?.status === "ok" &&
      field(pa, "classification") === "additive" &&
      ev?.verification.ok === true;
    const tour = await api.tour(c.id).catch(() => null);
    const toured = tour !== null && tour.tour.stops.length > 0 && tour.stale !== true;
    const items: CheckItem[] = [
      {
        name: "public-api-additive",
        pass: additive,
        detail: `change ${c.id}: ${pa ? `public-api ${pa.status}/${String(field(pa, "classification"))}` : "no public-api item"}`,
      },
      {
        name: "lane-1",
        pass: c.lane === 1,
        detail: `change ${c.id}: lane ${c.lane ?? "unassigned"}`,
      },
      {
        name: "tour",
        pass: toured,
        detail: `change ${c.id}: ${tour ? `${tour.tour.stops.length} stops${tour.stale ? " (stale)" : ""}` : "no tour"}`,
      },
    ];
    const score = items.filter((i) => i.pass).length;
    if (best === null || score > best.score) best = { id: c.id, items, score };
  }
  if (best) return best.items;
  return ["public-api-additive", "lane-1", "tour"].map((name) => ({
    name,
    pass: false,
    detail: "no agent Change created during the run",
  }));
}

export async function checkOnce(input: CheckInput, deps: CheckDeps): Promise<CheckOutput> {
  const state = await loadRunState(input, deps.api);
  const checks: CheckItem[] = [
    {
      name: "project-created",
      pass: state.repos.length > 0,
      detail: state.repos.length
        ? `projects ${state.repos.map((r) => `${r.id} (${r.claim.status})`).join(", ")}`
        : `no project created during the run (harvested ids: ${input.harvest.repoIds.join(", ") || "none"})`,
    },
  ];
  let ttfgMs: number | null = null;
  let ttfgSource: CheckOutput["ttfgSource"] = null;
  if (input.task === "t1" || input.task === "t4") {
    const p = await checkPreview(state, input, deps);
    checks.push(p.item);
    if (p.item.pass) {
      ttfgMs = p.ttfgMs;
      ttfgSource = p.ttfgSource;
    }
  }
  if (input.task === "t2") checks.push(...checkImportFix(state, input));
  if (input.task === "t3") checks.push(...(await checkLibraryApi(state, input, deps.api)));
  if (input.task === "t4") {
    const shell = input.toolCounts.shell ?? 0;
    checks.push({ name: "no-shell", pass: shell === 0, detail: `${shell} shell calls` });
    const ws = input.mcpCalls.filter((c) => c.name === "open_workspace");
    checks.push({
      name: "used-open-workspace (informational)",
      pass: true,
      detail: ws.length
        ? `${ws.length} open_workspace calls, ${ws.filter((c) => !c.isError).length} succeeded`
        : "open_workspace was never called",
    });
  }
  return {
    success: checks.every((c) => c.pass),
    checks,
    ttfgMs,
    ttfgSource,
    repoIds: state.repos.map((r) => r.id),
    changeIds: state.changes.map((c) => c.id),
  };
}

/**
 * Checks, re-checking every 10 s for up to `graceMs` while it fails: CI, previews and tours keep
 * finishing for a little while after an agent stops. A checker error (platform API down) is a
 * failed check, never a pass.
 */
export async function checkRun(
  input: CheckInput,
  deps: CheckDeps,
  opts: { graceMs: number; intervalMs?: number },
): Promise<CheckOutput> {
  const deadline = deps.now() + opts.graceMs;
  for (;;) {
    let out: CheckOutput;
    try {
      out = await checkOnce(input, deps);
    } catch (e) {
      out = {
        success: false,
        checks: [
          {
            name: "checker",
            pass: false,
            detail: `checker error: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
        ttfgMs: null,
        ttfgSource: null,
        repoIds: [],
        changeIds: [],
      };
    }
    if (out.success || deps.now() >= deadline) return out;
    await deps.sleep(opts.intervalMs ?? 10_000);
  }
}
