/**
 * Trust and safety: the invariants the platform enforces, stated plainly.
 */
const RULES = [
  {
    title: "Nobody approves their own work",
    text: "No principal, human or agent, approves a plan or change it wrote.",
  },
  {
    title: "Agents never approve",
    text: "They draft plans, push changes and ask for review. Approval is a person's signed act.",
  },
  {
    title: "Policy comes from the base branch",
    text: "A change is judged by main's rules, never by rules it edits itself. Policy edits always get a full review.",
  },
  {
    title: "Unknown escalates",
    text: "A missing or failed signal can only raise a lane. A model's judgment can only raise it too.",
  },
  {
    title: "Evidence is signed and portable",
    text: "Ed25519 signatures over every item, stored as git notes. Verify them in your own clone.",
  },
  {
    title: "The audit log is hash-chained",
    text: "Approvals, merges, flag changes and reverts are recorded in order; editing one entry breaks the chain.",
  },
  {
    title: "CI is sandboxed and holds no secrets",
    text: "Steps run in containers without credentials, so agent-written code never sees a secret.",
  },
  {
    title: "Data stays in the EU",
    text: "Repositories, the database and blob storage live in Cloudflare's EU jurisdiction.",
  },
];

export function Rules() {
  return (
    <section class="l-section rules wrap" id="rules" aria-labelledby="rules-title">
      <div class="l-head">
        <h2 class="l-h2" id="rules-title">
          Rules the platform will not bend.
        </h2>
        <p class="l-lede">
          Enforced by the platform on every request, for people and agents alike.
        </p>
      </div>
      <ul class="rules__list">
        {RULES.map((r) => (
          <li key={r.title}>
            <h3>{r.title}</h3>
            <p>{r.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
