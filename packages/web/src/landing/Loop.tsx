/**
 * How it works: the change on the hero tag (chg_fx2r7), carried through every station from the
 * approved plan to its rollout. The spine is that change's progress: six stations done, the
 * rollout in progress. A real sequence, so the stations are numbered.
 */
import type { ComponentChildren } from "preact";
import { EXAMPLE, MEASURED } from "./content.js";
import { ChangeArtifact, LaneArtifact, PlanArtifact } from "./LoopArtifacts.js";
import { Shot } from "./Shot.js";

interface Station {
  id: string;
  name: string;
  lead: string;
  body: string;
  /** A number measured on the live platform, shown as a figure. */
  measured?: { figure: string; text: string };
  art: ComponentChildren;
  /** Where this change is now. */
  now?: string;
}

const STATIONS: Station[] = [
  {
    id: "plan",
    name: "Plan",
    lead: "A person approves the intent before any code exists.",
    body: "An agent drafts the plan: what should change, how you will know it worked, what is out of scope, the risks it accepts and the paths it may touch. Someone other than its author approves it, and the approval is signed.",
    art: <PlanArtifact />,
  },
  {
    id: "change",
    name: "Change",
    lead: "Each agent task gets its own fork.",
    body: "Forks are cheap, and a change's push token reaches only its fork. Nobody pushes to main: the merge queue is its only writer.",
    art: <ChangeArtifact />,
  },
  {
    id: "evidence",
    name: "Evidence",
    lead: "CI proves what the change claims, and signs it.",
    body: "Every push runs in a sandbox with no secrets. A fix needs a test that fails on main and passes on the change. Tests, changed-line coverage, mutation score, public-API and dependency diffs and sensitive paths are measured, signed with Ed25519 and written to git notes, so they travel with the repo and verify without us.",
    measured: { figure: MEASURED.pushToEvidence, text: "from push to signed evidence" },
    art: (
      <Shot
        name="evidence-wide"
        narrow="evidence-narrow"
        alt={`Evidence for ${EXAMPLE.id}: signed and verified, with the platform key, signing time, head commit 19c18b6, digest, the git note it was written to, and the command to verify it from a clone.`}
      />
    ),
  },
  {
    id: "lane",
    name: "Lane",
    lead: "The evidence decides who looks.",
    body: "The lane comes from the evidence, never from the author's description of its own work. Each signal forces a minimum lane and the highest one wins. A missing or failed signal can only raise it, and so can a model's judgment: here it is the only reason a person looks at all.",
    art: <LaneArtifact />,
  },
  {
    id: "tour",
    name: "Tour",
    lead: "A second agent explains the change, riskiest part first.",
    body: "The reviewer is a separate agent from the author. Every stop is tied to evidence, and the tour has to say what it is least sure about and what it did not do. A Lane 1 tour is written to be read on a phone in under three minutes.",
    measured: { figure: MEASURED.tourCost, text: "per change for the reviewer agent" },
    art: (
      <div class="phones">
        <div class="phone">
          <Shot
            name="tour-fx-top"
            alt={`The tour for ${EXAMPLE.id} on a phone: Lane 1, glance, because totals can use a rate up to 60 seconds old; the reviewer agent is least confident that cache hit rates in production will match tests, and did not add a hit-rate metric.`}
          />
        </div>
        <div class="phone">
          <Shot
            name="tour-fx-risk"
            alt="The tour's riskiest stop: totals can use a rate up to 60 seconds old, unproven, accepted in the plan as a trade-off, with the model's hidden-behavior-change concern as its evidence."
          />
        </div>
      </div>
    ),
  },
  {
    id: "queue",
    name: "Merge queue",
    lead: "Main only moves to a tree that passed.",
    body: "Changes are tested on exactly the tree that will land, in parallel when they touch different code, each batch on top of the one before it. When two changes conflict, an agent resolves it and the resolution gets its own evidence. It never approves itself.",
    art: (
      <figure class="art-figure">
        <Shot
          name="queue-wide"
          narrow="queue-narrow"
          alt="A merge queue track: batch b_41 running CI on main, and batch b_42 building speculatively on top of b_41."
        />
        <figcaption>Other demo changes in the queue; {EXAMPLE.id} landed earlier.</figcaption>
      </figure>
    ),
  },
  {
    id: "rollout",
    name: "Rollout",
    lead: "Every change ships behind its own flag.",
    body: "After merge, a change reaches 5% of traffic, then 25%, then everyone, followed by a watch window. If its error rate passes the baseline or a new error group appears, the platform switches the flag off and opens a revert. One switch undoes one change.",
    now: "Now at 25% of traffic",
    art: (
      <Shot
        name="rollout-wide"
        narrow="rollout-narrow"
        alt={`The rollout of ${EXAMPLE.id}: at 25% of traffic with 4 minutes left, then 100% and a 30-minute watch, behind the flag chg_fx2r7.cache-fx-rates.`}
      />
    ),
  },
];

export function Loop() {
  return (
    <section class="l-section loop wrap" id="loop" aria-labelledby="loop-title">
      <div class="l-head">
        <h2 class="l-h2" id="loop-title">
          One change, from intent to production.
        </h2>
        <p class="l-lede">
          The change on the tag, followed through seven steps. It is rolling out now. Screens are
          from the product, with demo data.
        </p>
      </div>
      <ol class="loop__list">
        {STATIONS.map((s, i) => (
          <li
            class={`station ${s.now ? "station--now" : "station--done"}`}
            id={s.id}
            key={s.id}
            aria-labelledby={`${s.id}-title`}
          >
            <span class="station__num" aria-hidden="true">
              {i + 1}
            </span>
            <div class="station__text">
              <h3 class="station__name" id={`${s.id}-title`}>
                {s.name}
                {s.now ? <span class="station__now">{s.now}</span> : null}
              </h3>
              <p class="station__lead">{s.lead}</p>
              <p class="station__body">{s.body}</p>
              {s.measured ? (
                <p class="station__measured">
                  <b>{s.measured.figure}</b> {s.measured.text}, measured on the live platform
                </p>
              ) : null}
            </div>
            <div class="station__art">{s.art}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}
