# gittifacts

An agent-native git platform on Cloudflare.

**Humans approve intent. Machines prove conformance.** The platform routes each change to the
cheapest review that is still safe, and makes changes easy to undo after merge.

- The unit of work is a **Change**: intent + diff + evidence.
- Humans approve the **Plan**. A diff gets a conformance check against that plan.
- Every Change gets a **risk lane** (0 auto-merge, 1 async glance, 2 full review), computed from
  objective, signed evidence.
- Lane 1 and 2 reviewers read a **guided tour**, written by a reviewer agent that is not the author.
- Merged changes roll out gradually behind a per-change flag and revert themselves on regressions.

See `STATUS.md` for what works today and `DECISIONS.md` for why things are the way they are.
