/**
 * A Change the merge queue's resolver rewrote, waiting for a person to approve the resolution
 * (journey 06): the agent linked the docs from the README intro, an upstream Change reworded the
 * same line first, and the resolver merged both into a line found on neither side.
 */
import { sha } from "./fixture-kit.js";
import type { ResolutionView } from "./resolution.js";
import {
  apiNone,
  depsNone,
  file,
  hunk,
  reason,
  type Scenario,
  scenario,
  sensitive,
  stop,
  testRun,
} from "./scenario-kit.js";

const EDGE = "repo_edge";
const ID = "chg_rs6q1";
const RESOLVED = sha(`${ID}:resolved`);
const ONTO = sha(`${ID}:onto`);

const DIFF = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,11 +1,5 @@",
  " # edge-router",
  " ",
  "-<<<<<<<<<<<<< upstream",
  "-Routes edge traffic. Read the docs before changing a route.",
  "-||||||||||||| base",
  "-Routes edge traffic.",
  "-=============",
  "-Routes edge traffic. Docs: https://gittifacts.decroockjovi.workers.dev/docs",
  "->>>>>>>>>>>>> change",
  "+Routes edge traffic. Read the docs (https://gittifacts.decroockjovi.workers.dev/docs) before changing a route.",
  " ",
  " ## Install",
  "",
].join("\n");

const base = scenario({
  id: ID,
  repoId: EDGE,
  planId: null,
  title: "README: link the gittifacts docs from the intro",
  category: "chore",
  authorId: "prn_coder07",
  status: "awaiting-review",
  computedLane: 1,
  lane: 1,
  reasons: [
    reason(
      "merge-queue.resolution-novel-lines",
      1,
      "The conflict resolution wrote 1 line(s) found on neither side: the earlier approval no longer covers what lands.",
    ),
    reason(
      "resolution.within-conflict",
      0,
      "Conflict resolution against chg_up3d8 only replaced the 1 conflict hunk(s) (system:resolver).",
      "conflict-resolution",
    ),
  ],
  files: [
    file("README.md", "modified", [
      hunk(
        1,
        1,
        [
          " # edge-router",
          " ",
          "-Routes edge traffic.",
          "+Routes edge traffic. Docs: https://gittifacts.decroockjovi.workers.dev/docs",
          " ",
          " ## Install",
        ].join("\n"),
      ),
    ]),
  ],
  createdMin: 40,
  updatedMin: 2,
  tour: {
    stops: [
      stop(
        "resolution",
        "unproven",
        "Conflict resolution against 1 upstream change",
        "The merge queue's resolver agent (system:resolver, @cf/moonshotai/kimi-k2.7-code), not the author, resolved conflicts with upstream chg_up3d8. It only replaced the conflict hunks in README.md; every other line is the mechanical merge. 1 resolved line(s) appear on neither side of their conflict. No passing test run on the merged tree proves the result.",
        [],
        ["conflict-resolution"],
      ),
      stop(
        "intent",
        "unproven",
        "No plan; diff matches the change title",
        "No plan is attached. The title says the README should link to the docs; the diff adds that link to the intro line.",
        [{ file: "README.md", startLine: 3, endLine: 3 }],
      ),
      stop(
        "risk",
        "risk",
        "The link target is not verified",
        "Nothing checks that the URL resolves to the docs.",
        [{ file: "README.md", startLine: 3, endLine: 3 }],
      ),
    ],
    leastConfident: [
      "Whether the resolved sentence keeps upstream's advice and the link in the order readers expect.",
    ],
    notDone: ["Did not open the docs URL."],
  },
  items: [testRun(ID, 4), apiNone(), depsNone(), sensitive([])],
});

const resolution: ResolutionView = {
  headSha: RESOLVED,
  originalHeadSha: base.change.headSha,
  resolvedFrom: base.change.headSha,
  ontoSha: ONTO,
  at: new Date(Date.now() - 3 * 60_000).toISOString(),
  attempt: 1,
  kind: "textual",
  item: {
    id: "conflict-resolution",
    kind: "conflict-resolution",
    status: "ok",
    upstreamChanges: [{ changeId: "chg_up3d8", sha: ONTO }],
    ontoSha: ONTO,
    conflictHunks: [{ file: "README.md", startLine: 3, endLine: 3 }],
    resolutionDiff: DIFF,
    truncated: false,
    touchesOutsideConflictHunks: false,
    novelLines: 1,
    semanticConflictWith: null,
    rationale: "Kept upstream's advice to read the docs and the change's link, in one sentence.",
    resolver: {
      model: "@cf/moonshotai/kimi-k2.7-code",
      principalId: "system:resolver",
      promptVersion: "resolver/v3",
    },
    attempts: 1,
  },
  upstream: [
    { changeId: "chg_up3d8", title: "README: ask people to read the docs first", sha: ONTO },
  ],
  tourId: base.tour?.id ?? null,
  approvalRequested: true,
  lane: 1,
  reasons: ["merge-queue.resolution-novel-lines"],
};

export const RESOLUTION_SCENARIOS: Scenario[] = [
  { ...base, tour: base.tour ? { ...base.tour, headSha: RESOLVED } : null, resolution },
];
