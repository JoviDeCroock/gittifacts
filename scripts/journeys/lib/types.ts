import type { Journey } from "./journey.js";

/**
 * Ids the journeys act on, produced by the agent-side setup (setup.ts) or noted by hand.
 * Everything is optional: a journey that needs a missing id fails with a clear message.
 */
export interface State {
  /** Unclaimed project + its claim link (journey 2, desktop and phone). */
  claimUrl?: string;
  claimUrlMobile?: string;
  /** A claimed project the dogfood human owns, with an agent's Plan and Changes on it. */
  projectId?: string;
  planId?: string;
  /** Changes waiting for review (journey 4, desktop and phone). */
  reviewChangeId?: string;
  reviewChangeIdMobile?: string;
  /** Changes the merge-queue journey approves at its start. */
  queueChangeIds?: string[];
  /** A Change the resolver changed in the queue, waiting for re-approval (journey 6). */
  resolvedChangeId?: string;
  /** A Lane 0 change that merged with no human (journey 5). */
  lane0ChangeId?: string;
  /** A change the platform rolled back and reverted (journey 7). */
  revertedChangeId?: string;
  /** The project with deploy trains (journeys 6 and 7). */
  trainsProjectId?: string;
  /** Sign-up details for the phone claim (a fresh human). */
  newHuman?: { name: string; email: string; password: string };
  /** The dogfood human's sign-in (desktop claim). */
  human?: { email: string; password: string };
  [key: string]: unknown;
}

export interface HumanJourney {
  number: string;
  slug: string;
  title: string;
  subtitle?: string;
  mode?: "live" | "mock";
  /** Has a 390×844 variant. */
  mobile?: boolean;
  /** Starts signed in (the cookie jar). */
  signedIn?: boolean;
  headed?: boolean;
  run(j: Journey, state: State, opts: { mobile: boolean }): Promise<void>;
}
