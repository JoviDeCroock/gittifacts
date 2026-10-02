import { useSignal } from "@preact/signals";
import { inlineError, newIdempotencyKey } from "../api/client.js";
import { membersApi, type RepoRole, ROLE_COPY, ROLES } from "../api/members.js";
import { Button } from "../components/ui.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Owners add an existing user by e-mail; the role defaults to the least that lets them help. */
export function AddMember({ repoId, onAdded }: { repoId: string; onAdded: () => void }) {
  const email = useSignal("");
  const role = useSignal<RepoRole>("reviewer");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const added = useSignal<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    const value = email.value.trim();
    if (!EMAIL.test(value)) {
      error.value = "Enter the e-mail they sign in with.";
      return;
    }
    busy.value = true;
    error.value = null;
    added.value = null;
    try {
      const { member } = await membersApi.add(
        repoId,
        { email: value, role: role.value },
        newIdempotencyKey(),
      );
      email.value = "";
      added.value = `${member.name} is now a ${ROLE_COPY[member.role].label.toLowerCase()}.`;
      onAdded();
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  return (
    <form
      class="section add-member"
      onSubmit={submit}
      aria-labelledby="add-member-title"
      noValidate
    >
      <h2 id="add-member-title" class="add-member__title">
        Add a person
      </h2>
      <p class="add-member__lede">
        They need to have signed in once. Only people are members; their agents act with their role.
      </p>
      <div class="add-member__fields">
        <label class="field">
          <span class="field__label">E-mail</span>
          <input
            class="input"
            type="email"
            value={email.value}
            onInput={(e) => (email.value = e.currentTarget.value)}
            placeholder="name@company.com"
            autoCapitalize="off"
            autoCorrect="off"
            spellcheck={false}
            aria-invalid={error.value ? "true" : undefined}
            aria-describedby={error.value ? "add-member-error" : undefined}
          />
        </label>
        <label class="field">
          <span class="field__label">Role</span>
          <select
            class="input"
            value={role.value}
            onChange={(e) => (role.value = e.currentTarget.value as RepoRole)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_COPY[r].label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="primary" icon="plus" busy={busy.value} busyLabel="Adding">
          Add
        </Button>
      </div>
      {error.value ? (
        <p class="field__error" id="add-member-error" role="alert">
          {error.value}
        </p>
      ) : null}
      {added.value ? (
        <p class="add-member__done" role="status">
          {added.value}
        </p>
      ) : null}
    </form>
  );
}

/** What each role may do, lowest first: every role includes the ones above it. */
export function RoleGuide() {
  return (
    <section class="section role-guide" aria-labelledby="role-guide-title">
      <h2 id="role-guide-title" class="role-guide__title">
        What each role may do
      </h2>
      <dl class="role-guide__list">
        {ROLES.map((r) => (
          <div key={r} class="role-guide__row">
            <dt>{ROLE_COPY[r].label}</dt>
            <dd>
              {r === "reader" ? "" : "Everything above, and: "}
              {ROLE_COPY[r].may}
            </dd>
          </div>
        ))}
      </dl>
      <p class="role-guide__note">
        Nobody approves their own plan or change. An unclaimed project has no members until someone
        claims it.
      </p>
    </section>
  );
}
