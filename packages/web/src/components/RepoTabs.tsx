/**
 * A repository's places: its Changes (what is in flight), its Code and Commits (what has landed)
 * and Activity. Links, not a tab widget: each is its own page, the current one marked
 * `aria-current` and underlined in the action ink (the One Ink Rule's current selection).
 */
import { activityHref, commitsHref, treeHref } from "../lib/code.js";
import { Icon, type IconId } from "./Icon.js";
import "../styles/repo-tabs.css";

export type RepoPlace = "changes" | "code" | "commits" | "activity";

export function RepoTabs({ repoId, current }: { repoId: string; current: RepoPlace }) {
  const places: Array<{ id: RepoPlace; label: string; icon: IconId; href: string }> = [
    {
      id: "changes",
      label: "Changes",
      icon: "git-branch",
      href: `/repos/${encodeURIComponent(repoId)}`,
    },
    { id: "code", label: "Code", icon: "code", href: treeHref(repoId) },
    { id: "commits", label: "Commits", icon: "git-commit", href: commitsHref(repoId) },
    { id: "activity", label: "Activity", icon: "activity", href: activityHref(repoId) },
  ];
  return (
    <nav class="repo-tabs" aria-label="Repository">
      <ul>
        {places.map((p) => (
          <li key={p.id}>
            <a href={p.href} aria-current={p.id === current ? "page" : undefined}>
              <Icon name={p.icon} size={16} />
              {p.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
