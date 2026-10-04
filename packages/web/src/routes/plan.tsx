import type { Change, Plan } from "@app/domain";
import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { api, inlineError, newIdempotencyKey } from "../api/client.js";
import type { PrincipalRef, RepoDetail } from "../api/types.js";
import { Icon } from "../components/Icon.js";
import { Prose, ProseBlocks } from "../components/Prose.js";
import { Page } from "../components/Shell.js";
import { Button, ErrorState, Hash, LaneTag, Loading, StatusChip, Who } from "../components/ui.js";
import { formatDateTime, relative } from "../lib/time.js";
import { CHANGE_STATUS, PLAN_STATUS, plural } from "../lib/vocab.js";
import { minuteClock } from "../state/clock.js";
import { useMedia } from "../state/media.js";
import { useResource } from "../state/resource.js";
import { principal } from "../state/session.js";
import "../styles/plan.css";

interface PlanData {
  plan: Plan;
  changes: Change[];
  repo: RepoDetail;
  author: PrincipalRef | null;
  approver: PrincipalRef | null;
}

async function loadPlan(planId: string): Promise<PlanData> {
  const { plan, changes } = await api.plan(planId);
  const [repo, author, approver] = await Promise.all([
    api.repo(plan.repoId),
    api.principal(plan.authorId).then((r) => r.principal, () => null),
    plan.approvedBy ? api.principal(plan.approvedBy).then((r) => r.principal, () => null) : Promise.resolve(null),
  ]);
  return { plan, changes, repo, author, approver };
}

function SignaturePanel({ data, onPlan }: { data: PlanData; onPlan: (p: Plan) => void }) {
  const { plan, author, approver } = data;
  const me = principal.value;
  const read = useSignal(false);
  const comment = useSignal("");
  const mode = useSignal<"approve" | "reject">("approve");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const intentKey = useRef<string | null>(null);

  if (plan.status !== "draft") {
    return (
      <section class="signature" aria-labelledby="sig-title" data-testid="plan-decided" data-status={plan.status}>
        <h2 id="sig-title" class="signature__title">
          {plan.status === "approved" ? "Signed approval" : `Plan ${PLAN_STATUS[plan.status].label.toLowerCase()}`}
        </h2>
        <dl class="signature__block">
          <dt>Drafted by</dt>
          <dd>{author ? <Who kind={author.kind} name={author.name} owner={author.ownerName} size={20} /> : plan.authorId}</dd>
          <dt>Drafted</dt>
          <dd class="tnum">{formatDateTime(plan.createdAt)}</dd>
          {plan.status === "approved" ? (
            <>
              <dt>Approved by</dt>
              <dd>{approver ? <Who kind={approver.kind} name={approver.name} size={20} /> : plan.approvedBy}</dd>
              <dt>Approved</dt>
              <dd class="tnum">{plan.approvedAt ? formatDateTime(plan.approvedAt) : "—"}</dd>
              <dt>Signature</dt>
              <dd>
                {plan.approvalSignature ? (
                  <span class="signature__sig">
                    <Icon name="signature" size={15} />
                    <Hash value={plan.approvalSignature} head={10} tail={6} />
                  </span>
                ) : (
                  <span class="tone--danger">Missing. Treat this approval as unsigned.</span>
                )}
              </dd>
            </>
          ) : null}
        </dl>
        {plan.status === "approved" ? <p class="signature__fine">Ed25519, signed by the platform over the canonical plan and the approver.</p> : null}
      </section>
    );
  }

  if (me && plan.authorId === me.id) {
    return (
      <section class="signature signature--locked" aria-labelledby="sig-title">
        <h2 id="sig-title" class="signature__title">
          <Icon name="lock" size={18} /> You wrote this plan
        </h2>
        <p>Another person has to approve or reject it. Share the link with a teammate who has the plan:approve scope.</p>
      </section>
    );
  }

  const ownAgent = author?.kind === "agent" && author.ownerId === me?.id;

  async function submit(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    if (mode.value === "approve" && !read.value) {
      error.value = "Confirm you read the intent, criteria and out-of-scope list first.";
      return;
    }
    if (mode.value === "reject" && !comment.value.trim()) {
      error.value = "Say why you are rejecting the plan. The author sees this.";
      return;
    }
    busy.value = true;
    error.value = null;
    try {
      intentKey.current ??= newIdempotencyKey();
      const res =
        mode.value === "approve"
          ? await api.approvePlan(plan.id, comment.value.trim() || undefined, intentKey.current)
          : await api.rejectPlan(plan.id, comment.value.trim(), intentKey.current);
      onPlan(res.plan);
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  return (
    <section class="signature signature--open" id="sign" aria-labelledby="sig-title">
      <h2 id="sig-title" class="signature__title">
        {mode.value === "approve" ? "Approve this plan" : "Reject this plan"}
      </h2>
      {mode.value === "approve" ? (
        <p class="signature__consequence">
          Agents can then start changes inside {plural(plan.scopePaths.length, "scope path")}. Anything outside them is flagged as scope drift and gets a full review (Lane 2).
        </p>
      ) : (
        <p class="signature__consequence">The plan closes. Agents cannot start work on it, and the author has to draft a new one.</p>
      )}
      {ownAgent ? (
        <p class="signature__note">
          <Icon name="bot" size={16} /> Your agent {author?.name} drafted this. You are allowed to approve it, but a teammate's eyes are the stronger check.
        </p>
      ) : null}
      <form class="signature__form" onSubmit={submit}>
        {mode.value === "approve" ? (
          <label class="check signature__read">
            <input type="checkbox" checked={read.value} onChange={(e) => (read.value = e.currentTarget.checked)} data-testid="plan-read" />
            <span>I read the intent, the acceptance criteria and what is out of scope.</span>
          </label>
        ) : null}
        <label class="field">
          <span class="field__label">
            Comment{mode.value === "approve" ? <span class="field__hint"> (optional)</span> : null}
          </span>
          <textarea class="textarea" rows={3} value={comment.value} onInput={(e) => (comment.value = e.currentTarget.value)} aria-describedby={error.value ? "sig-error" : undefined} />
        </label>
        {error.value ? (
          <p class="field__error" id="sig-error" role="alert">
            {error.value}
          </p>
        ) : null}
        <p class="signature__fine">
          <Icon name="signature" size={14} /> You sign as {me?.name ?? "yourself"}. The platform signs the canonical plan with your approval and records it in the audit log.
        </p>
        <div class="signature__actions">
          {mode.value === "approve" ? (
            <>
              <Button variant="secondary" onClick={() => ((mode.value = "reject"), (error.value = null), (intentKey.current = null))}>
                Reject…
              </Button>
              <Button type="submit" variant="primary" icon="signature" busy={busy.value} busyLabel="Signing…" disabled={!read.value} wide data-testid="plan-approve">
                Sign and approve
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => ((mode.value = "approve"), (error.value = null), (intentKey.current = null))}>
                Back
              </Button>
              <Button type="submit" variant="danger" busy={busy.value} busyLabel="Rejecting…" wide>
                Reject plan
              </Button>
            </>
          )}
        </div>
      </form>
    </section>
  );
}

function PlanDoc({ data }: { data: PlanData }) {
  const { plan, changes } = data;
  return (
    <article class="plan-doc">
      <section class="plan-sec" aria-labelledby="intent">
        <h2 id="intent">Intent</h2>
        <ProseBlocks text={plan.intent} class="plan-doc__intent" />
      </section>

      <section class="plan-sec" aria-labelledby="criteria">
        <h2 id="criteria">
          Acceptance criteria <span class="plan-sec__n tnum">{plan.acceptanceCriteria.length}</span>
        </h2>
        <ol class="criteria">
          {plan.acceptanceCriteria.map((c, i) => (
            <li key={i}>
              <span class="criteria__n tnum" aria-hidden="true">
                {i + 1}
              </span>
              <span>
                <Prose text={c} />
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section class="plan-sec" aria-labelledby="oos">
        <h2 id="oos">Out of scope</h2>
        {plan.outOfScope.length === 0 ? (
          <p class="plan-sec__empty">Nothing declared out of scope.</p>
        ) : (
          <ul class="oos">
            {plan.outOfScope.map((o, i) => (
              <li key={i}>
                <Icon name="minus" size={16} />
                <span>
                  <Prose text={o} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="plan-sec" aria-labelledby="risks">
        <h2 id="risks">Declared risks</h2>
        {plan.riskDeclarations.length === 0 ? (
          <p class="plan-sec__empty">The author declared no risks. The classifier and the reviewer agent still look for them.</p>
        ) : (
          <dl class="risks">
            {plan.riskDeclarations.map((r, i) => (
              <div key={i} class="risks__item">
                <dt>
                  <Icon name="triangle-alert" size={16} />
                  {r.area}
                </dt>
                <dd>
                  <Prose text={r.description} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section class="plan-sec plan-sec--cols">
        <div>
          <h2>Scope paths</h2>
          {plan.scopePaths.length === 0 ? (
            <p class="plan-sec__empty">Not declared. Every change under this plan counts as unknown scope, which rules out auto-merge.</p>
          ) : (
            <ul class="globs">
              {plan.scopePaths.map((g) => (
                <li key={g}>
                  <code>{g}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2>Affected routes</h2>
          {plan.affectedRoutes.length === 0 ? (
            <p class="plan-sec__empty">None. No before/after screenshots will be taken.</p>
          ) : (
            <ul class="globs">
              {plan.affectedRoutes.map((g) => (
                <li key={g}>
                  <code>{g}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section class="plan-sec" aria-labelledby="plan-changes">
        <h2 id="plan-changes">
          Changes under this plan <span class="plan-sec__n tnum">{changes.length}</span>
        </h2>
        {changes.length === 0 ? (
          <p class="plan-sec__empty">{plan.status === "draft" ? "None yet. Agents can start once the plan is approved." : "None yet."}</p>
        ) : (
          <ul class="plan-changes">
            {changes.map((c) => (
              <li key={c.id}>
                <a href={`/changes/${c.id}`}>
                  <LaneTag lane={c.lane} shadow={c.computedLane === 0 && c.lane === 1} size="sm" />
                  <span class="plan-changes__title">{c.title}</span>
                  <StatusChip meta={CHANGE_STATUS[c.status]} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

export function PlanView({ planId }: { planId: string }) {
  const res = useResource(() => loadPlan(planId), [planId]);
  const desktop = useMedia("(min-width: 1100px)");
  const st = res.state.value;
  const crumbs = [{ href: "/dashboard", label: "Dashboard" }];
  if (st.status === "loading") {
    return (
      <Page title="Plan" crumbs={crumbs}>
        <Loading label="Loading the plan" lines={8} />
      </Page>
    );
  }
  if (st.status === "error") {
    return (
      <Page title="Plan" crumbs={crumbs}>
        <ErrorState error={st.error} what="this plan" onRetry={res.reload} />
      </Page>
    );
  }
  const data = st.data;
  const { plan, author, repo } = data;
  const isDraft = plan.status === "draft";
  const mine = principal.value?.id === plan.authorId;
  return (
    <Page
      title={plan.title}
      wide
      class="plan-page"
      crumbs={[...crumbs, { href: `/repos/${repo.repo.id}`, label: repo.repo.name }]}
      meta={
        <>
          <StatusChip meta={PLAN_STATUS[plan.status]} />
          {author ? <Who kind={author.kind} name={author.name} owner={author.ownerName} size={20} /> : null}
          <span>Drafted {relative(plan.createdAt, minuteClock.value)}</span>
        </>
      }
    >
      <div class="plan-layout">
        <PlanDoc data={data} />
        <aside class="plan-layout__rail">
          <SignaturePanel data={data} onPlan={(p) => res.set({ ...data, plan: p, approver: p.approvedBy === principal.value?.id && principal.value ? { id: principal.value.id, kind: principal.value.kind, name: principal.value.name, ownerId: null } : data.approver })} />
        </aside>
      </div>
      {isDraft && !desktop && !mine ? (
        <div class="plan-bar">
          <span class="plan-bar__text">Read to the end, then sign.</span>
          <Button
            variant="primary"
            icon="signature"
            onClick={() => document.getElementById("sign")?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            Review and sign
          </Button>
        </div>
      ) : null}
    </Page>
  );
}
