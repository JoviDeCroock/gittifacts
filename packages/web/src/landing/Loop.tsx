/**
 * How it works: one change (the tag in the hero) carried through every station, from the
 * approved plan to its rollout. A real sequence, so the stations are numbered.
 */
import type { ComponentChildren } from "preact";
import { MEASURED } from "./content.js";
import { ChangeArtifact, LaneArtifact, PlanArtifact } from "./LoopArtifacts.js";
import { Shot } from "./Shot.js";

interface Station {
  id: string;
  name: string;
  lead: string;
  body: string;
  measured?: string;
  art: ComponentChildren;
  /** Screens get the wider artifact column. */
  wide?: boolean;
}

const STATIONS: Station[] = [
  {
    id: "plan",
    name: "Plan",
    lead: "A person approves the intent before any code exists.",
    body: "An agent drafts the plan: what should change, how you will know it worked, what is out of scope and which paths it may touch. Someone other than its author approves it, and the approval is signed.",
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
    body: "Every push runs in a sandbox with no secrets. A fix needs a test that fails on main and passes on the change. Changed-line coverage, mutation score, public-API and dependency diffs and sensitive paths are measured, signed with Ed25519 and written to git notes, so they travel with the repo and verify without us.",
    measured: `${MEASURED.pushToEvidence} from push to signed evidence`,
    art: (
      <Shot
        name="evidence-wide"
        narrow="evidence-narrow"
        alt="The evidence view: signed and verified, with the key, signing time, head commit, digest, the git note it was written to, and the command to verify it from a clone."
      />
    ),
    wide: true,
  },
  {
    id: "lane",
    name: "Lane",
    lead: "The evidence decides who looks.",
    body: "The platform computes a lane from the evidence, never from the author's description of its own work. A missing or failed signal can only raise the lane, and so can a model's judgment.",
    art: <LaneArtifact />,
  },
  {
    id: "tour",
    name: "Tour",
    lead: "A second agent explains the change, riskiest part first.",
    body: "The reviewer is a separate agent from the author. Every stop is tied to evidence, and the tour has to say what it is least sure about and what it did not do. A Lane 1 tour reads on a phone in under three minutes.",
    measured: `${MEASURED.tourCost} per change for the reviewer agent`,
    art: (
      <div class="phone">
        <Shot
          name="tour-phone"
          alt="A tour on a phone: stop 1 of 5 with verdict marks, the Lane 1 glance tag, what the reviewer agent is unsure about, and Approve, Request changes and Reject in the thumb zone."
        />
      </div>
    ),
  },
  {
    id: "queue",
    name: "Merge queue",
    lead: "Main is never red.",
    body: "Changes are tested on exactly the tree that will land, in parallel when they touch different code, each batch on top of the one before it. When two changes conflict, an agent resolves it and the resolution gets its own evidence. It never approves itself.",
    art: (
      <Shot
        name="queue-wide"
        narrow="queue-narrow"
        alt="A merge queue track: batch b_41 running CI on main, and batch b_42 building speculatively on top of b_41."
      />
    ),
    wide: true,
  },
  {
    id: "rollout",
    name: "Rollout",
    lead: "Every change ships behind its own flag.",
    body: "After merge, a change reaches 5% of traffic, then 25%, then everyone, followed by a watch window. If its error rate passes the baseline or a new error group appears, the platform switches the flag off and opens a revert. One switch undoes one change.",
    art: (
      <Shot
        name="rollout-wide"
        narrow="rollout-narrow"
        alt="The rollout of chg_fx2r7: at 25% of traffic with 4 minutes left, then 100% and a 30-minute watch, behind the flag chg_fx2r7.cache-fx-rates."
      />
    ),
    wide: true,
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
          Follow the change on the tag above through all seven steps. Screens are from the product,
          with demo data.
        </p>
      </div>
      <ol class="loop__list">
        {STATIONS.map((s, i) => (
          <li
            class={`station ${s.wide ? "station--wide" : ""}`}
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
              </h3>
              <p class="station__lead">{s.lead}</p>
              <p class="station__body">{s.body}</p>
              {s.measured ? (
                <p class="station__measured">
                  <span class="station__measured-tick" aria-hidden="true" />
                  Measured on the live platform: {s.measured}.
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
