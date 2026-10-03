/**
 * The evidence note on main after the merge queue lands a Change (journey 05: the one Change that
 * merged with no human, a verified revert landed on the fast path, read "Git note: Not written").
 * The queue re-signs the evidence for the merged sha (which starts the row at notesWritten false),
 * writes the note on main, and must record that it did; a failed write is audited, not swallowed.
 */
import { EVIDENCE_NOTES_REF } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { sealEvidence } from "../../src/evidence.js";
import { queueEnv } from "./queue-harness.js";

describe("evidence note on main after a merge", () => {
  it("fast path: the head lands as is, and its evidence row records the note on main", async () => {
    const env = await queueEnv();
    const c1 = await env.change("c1", { "src/b.ts": "export const b = 1;\n" });
    const head = c1.headSha ?? "";
    // The ChangeWorkflow sealed the head's evidence and wrote its note on the fork.
    await sealEvidence(env.ports, {
      changeId: "c1",
      headSha: head,
      baseSha: c1.baseSha,
      items: [],
      notesWritten: true,
    });
    await env.admit(c1);
    await env.drive();

    expect(env.ports.git.head("app")).toBe(head); // the head IS the merged commit
    expect((await env.ports.store.getChange("c1"))?.mergedSha).toBe(head);
    const note = await env.ports.git.readNote("app", head, EVIDENCE_NOTES_REF);
    expect(note).not.toBeNull();
    // The same row the evidence page shows for this Change: re-signed for what landed, noted.
    expect((await env.ports.store.getEvidence("c1", head))?.notesWritten).toBe(true);
    expect(env.ports.audit.actions()).not.toContain("merge-queue.evidence-note-failed");
  });

  it("replayed onto a moved main: the merged commit's row records its note too", async () => {
    const env = await queueEnv();
    const c1 = await env.change("c1", { "src/b.ts": "export const b = 1;\n" });
    const c2 = await env.change("c2", { "src/c.ts": "export const c = 1;\n" });
    await env.admit(c1);
    await env.admit(c2);
    await env.drive();

    for (const id of ["c1", "c2"]) {
      const merged = (await env.ports.store.getChange(id))?.mergedSha ?? "";
      expect(merged).not.toBe("");
      expect((await env.ports.store.getEvidence(id, merged))?.notesWritten, id).toBe(true);
    }
    const notes = env.ports.git.repo("app").notes.get(EVIDENCE_NOTES_REF);
    expect(notes?.size ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("a failed note write is audited with its error and left unrecorded; the merge stands", async () => {
    const env = await queueEnv();
    const { git } = env.ports;
    const write = git.writeNote.bind(git);
    git.writeNote = async (repo, ...rest) => {
      if (repo === "app") throw new Error("notes push refused: 500");
      return write(repo, ...rest);
    };
    const c1 = await env.change("c1", { "src/b.ts": "export const b = 1;\n" });
    await env.admit(c1);
    await env.drive();

    const head = c1.headSha ?? "";
    expect((await env.ports.store.getChange("c1"))?.status).toBe("merged");
    expect((await env.ports.store.getEvidence("c1", head))?.notesWritten).toBe(false);
    expect(env.ports.audit.payloadOf("merge-queue.evidence-note-failed")).toMatchObject({
      sha: head,
      error: "notes push refused: 500",
    });
  });
});
