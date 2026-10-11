/**
 * Small artifacts drawn in the app's own components for the loop stations that have no
 * screenshot: the approved plan, the change's fork, and the three lanes. All for chg_fx2r7.
 */

import type { LaneReason } from "@app/domain";
import { Icon } from "../components/Icon.js";
import { TriageChart } from "../components/TriageChart.js";
import { LaneTag } from "../components/ui.js";
import { EXAMPLE } from "./content.js";

export function PlanArtifact() {
  return (
    <div class="art art-plan">
      <p class="art-plan__head">
        <Icon name="file-text" size={16} /> Plan for {EXAMPLE.repo}, drafted by {EXAMPLE.agent}
      </p>
      <p class="art-plan__title">FX rate caching</p>
      <p class="art-plan__intent">
        Cut FX lookups per invoice total to one per currency per minute.
      </p>
      <dl class="art-plan__facts">
        <div>
          <dt>Done when</dt>
          <dd>Rates are cached for at most 60 seconds.</dd>
        </div>
        <div>
          <dt>Risk</dt>
          <dd>Totals may use a rate up to 60 s old; finance accepted this.</dd>
        </div>
        <div>
          <dt>Out of scope</dt>
          <dd>Persisted rate history.</dd>
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
        <span class="c-out">→ CI started on 19c18b6</span>
        {"\n\n"}
        <span class="c-call">git push</span> origin main{"\n"}
        <span class="c-err">→ refused: only the merge queue writes main</span>
      </code>
    </pre>
  );
}

/** chg_fx2r7's lane reasons, as the classifier reports them (fixture: api/scenarios.ts). */
const FX_REASONS: LaneReason[] = [
  { code: "scope.within", lane: 0, message: "The diff stays inside the plan's scope paths." },
  { code: "tests.passed", lane: 0, message: "418 tests pass, none fail." },
  { code: "coverage.changed-lines", lane: 0, message: "91% of changed lines covered." },
  { code: "api.none", lane: 0, message: "No change to the public API." },
  { code: "dependencies.none", lane: 0, message: "No dependency added or bumped." },
  { code: "sensitive.none", lane: 0, message: "No sensitive path touched." },
  {
    code: "llm.hidden-behavior-change",
    lane: 1,
    message: "Totals can use a rate up to 60 seconds old.",
  },
];

/** The app's observation chart for this change: every signal, and the one that forced Lane 1. */
export function LaneArtifact() {
  return (
    <div class="art art-lanes">
      <TriageChart
        reasons={FX_REASONS}
        computedLane={1}
        lane={1}
        foldPassing={false}
        caption={`Why ${EXAMPLE.id} gets a quick review (Lane 1)`}
      />
      <p class="art-lanes__shadow">
        <LaneTag lane={0} shadow size="sm" />
        <span>
          Auto-merge starts out calibrating: computed on every change while a person still reviews,
          until reviewers have agreed with it on 95% of at least 25 changes.
        </span>
      </p>
    </div>
  );
}
