/**
 * Trust and safety: the invariants the platform enforces. Where a rule produces a refusal an
 * agent actually sees, the refusal is quoted (apps/platform/src/services/plans.ts).
 */
const RULES: { title: string; text: string; refusal?: string }[] = [
  {
    title: "Nobody approves their own work",
    text: "No one, person or agent, approves a plan or a change they wrote.",
    refusal: "403 self-approval: nobody can approve their own plan",
  },
  {
    title: "Agents never approve",
    text: "They draft plans, push changes and ask for review. Approval is a person's signed act.",
    refusal: "403 forbidden: only a human may approve or reject a plan",
  },
  {
    title: "Policy comes from the base branch",
    text: "A change is judged by main's rules, never by rules it edits itself. A policy edit always gets a full review.",
  },
  {
    title: "Unknown escalates",
    text: "A measurement that is missing or failed to run can only raise the lane, never lower it.",
  },
  {
    title: "Evidence is signed and portable",
    text: "One Ed25519 signature covers every item, stored as git notes beside the commit. Verify it in your own clone.",
  },
  {
    title: "The audit log is hash-chained",
    text: "Approvals, merges, flag changes and reverts are recorded in order; changing one entry breaks the chain.",
  },
];

export function Rules() {
  return (
    <section class="l-section rules wrap" id="rules" aria-labelledby="rules-title">
      <div class="l-head">
        <h2 class="l-h2" id="rules-title">
          Rules the platform will not bend.
        </h2>
        <p class="l-lede">Enforced on every request, for people and agents alike.</p>
      </div>
      <ul class="rules__list">
        {RULES.map((r) => (
          <li key={r.title}>
            <h3>{r.title}</h3>
            <p>{r.text}</p>
            {r.refusal ? (
              <p class="rules__refusal">
                <code>{r.refusal}</code>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <p class="rules__ops">
        <strong>Where it runs.</strong> On Cloudflare. Repositories live in Artifacts, Workflows and
        Durable Objects run each change and the merge queue, CI steps run in sandboxed Containers
        that hold no secrets, the reviewer agent reaches its models through AI Gateway, and every
        change gets a Flagship flag. Repositories, the database and blob storage stay in the EU
        jurisdiction.
      </p>
    </section>
  );
}
