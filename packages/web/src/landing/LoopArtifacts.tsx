/**
 * Small artifacts drawn in the app's own components for the loop stations that have no
 * screenshot: the approved plan, the change's fork, and the three lanes. All for chg_fx2r7.
 */
import { Icon } from "../components/Icon.js";
import { LaneTag } from "../components/ui.js";
import { EXAMPLE } from "./content.js";

export function PlanArtifact() {
  return (
    <div class="art art-plan">
      <p class="art-plan__head">
        <Icon name="file-text" size={16} /> Plan for {EXAMPLE.repo}
      </p>
      <p class="art-plan__title">Cache FX rates for 60 seconds</p>
      <p class="art-plan__intent">
        Totalling a 200-line invoice makes 200 rate lookups. Cap it at one lookup per currency per
        minute.
      </p>
      <dl class="art-plan__facts">
        <div>
          <dt>Done when</dt>
          <dd>One rate lookup per currency per minute; totals use a rate at most 60 s old</dd>
        </div>
        <div>
          <dt>Out of scope</dt>
          <dd>A metric for cache hit rate</dd>
        </div>
        <div>
          <dt>May touch</dt>
          <dd>
            <code>src/fx/**</code> <code>test/fx/**</code>
          </dd>
        </div>
      </dl>
      <p class="art-plan__seal">
        <Icon name="signature" size={18} />
        <span>
          Approved by <b>{EXAMPLE.approver}</b>, signed with Ed25519
        </span>
      </p>
    </div>
  );
}

export function ChangeArtifact() {
  return (
    <pre class="art art-code">
      <code>
        <span class="c-call">start_change</span>({"{"} repoId:{" "}
        <span class="c-str">"billing-api"</span>, planId: <span class="c-str">"plan_fx"</span> {"}"}
        ){"\n"}
        <span class="c-out">→ fork chg_fx2r7, with a push token for that fork only</span>
        {"\n\n"}
        <span class="c-call">git push</span> &lt;fork&gt; HEAD:chg_fx2r7{"\n"}
        <span class="c-out">→ CI started on 7f3c2a1</span>
        {"\n\n"}
        <span class="c-call">git push</span> origin main{"\n"}
        <span class="c-err">→ refused: only the merge queue writes main</span>
      </code>
    </pre>
  );
}

const LANE_RULES = [
  { lane: 2, name: "Full review", text: "A person reads the diff, with the tour as a guide." },
  { lane: 1, name: "Glance", text: "A person approves the tour, often on a phone." },
  {
    lane: 0,
    name: "Auto-merge",
    text: "Merges on evidence alone, once shadow mode has earned it.",
  },
] as const;

export function LaneArtifact() {
  return (
    <div class="art art-lanes">
      <ul>
        {LANE_RULES.map((l) => (
          <li key={l.lane} class={`art-lanes__row art-lanes__row--${l.lane}`}>
            <LaneTag lane={l.lane} size="lg" />
            <span>
              <b>{l.name}</b>
              {l.text}
            </span>
          </li>
        ))}
      </ul>
      <p class="art-lanes__shadow">
        <LaneTag lane={0} shadow size="sm" />
        <span>
          Lane 0 starts in shadow mode: computed on every change, while a person still glances,
          until reviewers have agreed with it on 95% of at least 25 changes.
        </span>
      </p>
    </div>
  );
}
