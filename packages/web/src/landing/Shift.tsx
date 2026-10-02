/**
 * The problem and the shift: the pull request's assumption, then what changes and what stays.
 */
import { SHIFTS } from "./content.js";

export function Shift() {
  return (
    <section class="l-section shift wrap" aria-labelledby="shift-title">
      <div class="shift__intro">
        <h2 class="l-h2" id="shift-title">
          The pull request assumes a person wrote the diff.
        </h2>
        <p class="l-body">
          So a person reads it, line by line, after the work is done. Now agents write most of the
          code, many changes at a time, and the scarce resource is the attention of the engineer who
          answers for what ships.
        </p>
        <p class="l-body">
          gittifacts is the git platform for what comes after the pull request. The unit of work is
          a change: the intent, the diff and the evidence that one matches the other, kept together.
        </p>
      </div>
      <div class="shift__table">
        <table>
          <caption class="sr-only">
            What changes when a team moves from pull requests to gittifacts
          </caption>
          <thead>
            <tr>
              <th scope="col">Before</th>
              <th scope="col">With gittifacts</th>
            </tr>
          </thead>
          <tbody>
            {SHIFTS.map((s) => (
              <tr key={s.before}>
                <th scope="row">{s.before}</th>
                <td>
                  <strong>{s.after}</strong>
                  <span>{s.detail}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p class="shift__stays">
          <strong>What stays:</strong> git. Your history, branches and git clients keep working
          against the new remote.
        </p>
      </div>
    </section>
  );
}
