/**
 * The case tag: one change at poster scale. A die-cut tag with a punched hole, the change's
 * signed evidence as rows, and tear-off lane strips. Every change starts owing a full review;
 * evidence tears off what it proves, and whatever stays attached is the review still owed.
 */
import { Avatar, LaneTag, VerdictMark } from "../components/ui.js";
import { EXAMPLE } from "./content.js";

export function CaseTag() {
  const e = EXAMPLE;
  return (
    <figure class="case" aria-labelledby="case-title" aria-describedby="case-caption">
      <div class="case__tag">
        {/* Outside the body's mask, so its inner shadow falls into the punched hole. */}
        <span class="case__eyelet" aria-hidden="true" />
        <div class="case__body">
          <p class="case__meta">
            <span>{e.repo}</span>
            <span class="case__chip">Demo data</span>
            <code>{e.id}</code>
          </p>
          <p class="case__title" id="case-title">
            {e.title}
          </p>
          <p class="case__who">
            <Avatar kind="agent" name={e.agent} size={20} />
            <span>
              <b>{e.agent}</b>, agent of {e.owner}
            </span>
          </p>
          <dl class="case__rows">
            {e.rows.map((r, i) => (
              <div class={`case__row case__row--${r.mark}`} key={r.label}>
                <dt>{r.label}</dt>
                <dd>
                  <span>{r.value}</span>
                  <span class="case__mark" style={{ "--i": i }}>
                    {r.mark === "proven" ? (
                      <>
                        <VerdictMark verdict="proven" size={18} />
                        <span class="sr-only">Proven</span>
                      </>
                    ) : (
                      <LaneTag lane={1} size="sm" />
                    )}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
          <p class="case__sig">
            Signed with Ed25519 at <code>{e.head}</code>, stored in <code>refs/notes/evidence</code>
          </p>
        </div>
        <div class="case__strip case__strip--1">
          <span class="case__num" aria-hidden="true">
            1
          </span>
          <span class="case__lane">
            <b>
              <span class="sr-only">Lane 1, </span>Glance: still owed
            </b>
            <span>A model check found a behavior change, so a person approves the tour.</span>
          </span>
        </div>
        <div class="case__strip case__strip--2">
          <span class="case__num" aria-hidden="true">
            2
          </span>
          <span class="case__lane">
            <b>
              <span class="sr-only">Lane 2, </span>Full review: torn off
            </b>
            <span>The evidence covers everything a full review would check.</span>
          </span>
        </div>
      </div>
      <figcaption class="case__caption" id="case-caption">
        Every change starts owing a full review. Signed evidence tears off what it proves; anything
        missing or unproven stays attached.
      </figcaption>
    </figure>
  );
}
