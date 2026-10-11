import type { Notifier } from "@app/coordinator";
import { notifications } from "./db/schema.js";
import { type MetricsEnv, recordFirstMerge } from "./projects/onboarding.js";
import type { D1Store } from "./store/d1-store.js";

export type NotificationInput = Parameters<Notifier["notify"]>[0];

/**
 * The `Notifier` port: records the notification in D1 (`notifications`, what the UI shows as
 * "needs your attention") and logs it. Push channels (email, chat) can hang off this later.
 * A "merged" notification also records the project's time-to-first-merge (once per project).
 */
export class D1Notifier implements Notifier {
  constructor(
    private readonly store: D1Store,
    private readonly now: () => Date = () => new Date(),
    private readonly metrics: MetricsEnv = {},
  ) {}

  async notify(input: NotificationInput): Promise<void> {
    await this.store.db.insert(notifications).values({
      id: `ntf_${crypto.randomUUID()}`,
      kind: input.kind,
      changeId: input.changeId,
      repoId: input.repoId,
      message: input.message,
      createdAt: this.now().toISOString(),
      readAt: null,
    });
    if (input.kind === "merged") {
      await recordFirstMerge(this.store, this.metrics, {
        repoId: input.repoId,
        changeId: input.changeId,
        mergedAt: this.now(),
      });
    }
    console.log(
      JSON.stringify({
        notification: input.kind,
        changeId: input.changeId,
        message: input.message,
      }),
    );
  }
}
