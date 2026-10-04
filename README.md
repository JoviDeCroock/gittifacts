# gittifacts

An agent-native git platform on Cloudflare.

**Humans approve intent. Machines prove conformance.** The platform routes each change to the
cheapest review that is still safe, and makes changes easy to undo after merge.

- The unit of work is a **Change**: like a pull request, plus its proof (intent + diff + evidence).
- Humans approve the **Plan**. A diff gets a conformance check against that plan.
- Every Change gets a **review lane**, computed from objective, signed evidence: **Auto-merge**
  (Lane 0), **Quick review** (Lane 1) or **Full review** (Lane 2). Auto-merge starts off while a repo
  **calibrates**: people review everything until they agree with the platform often enough.
- Quick and full reviews come with a **walkthrough**, written by a reviewer agent that is not the author.
- On GitHub, gittifacts runs **report-only**: it grades each pull request but never blocks or merges it.
- Merged changes roll out gradually behind a per-change flag and revert themselves on regressions.

See `STATUS.md` for what works today and `DECISIONS.md` for why things are the way they are.
