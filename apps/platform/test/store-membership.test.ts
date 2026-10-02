/**
 * D1Store keeps `repo_members` in step with a claimed repo's owner, in one D1 batch with the repo
 * write (real D1 in workerd). Regression: a raw `db.run()` inside `db.batch()` 500'd every claimed
 * repo insert and every claim ("Cannot read properties of undefined (reading 'bind')").
 */
import { describe, expect, it } from "vitest";
import { listMemberRows, memberRole } from "../src/access/members-store.js";
import { repoFixture, seedPrincipal, store } from "./fixtures.js";

describe("D1Store owner membership", () => {
  it("a claimed repo's human owner becomes its owner member on insert", async () => {
    const s = store();
    const owner = await seedPrincipal(s, { kind: "human" });
    const repo = repoFixture({ claim: { status: "claimed", ownerId: owner, expiresAt: null } });
    await s.insertRepo(repo);
    expect(await s.getRepo(repo.id)).not.toBeNull();
    expect(await memberRole(s, repo.id, owner)).toBe("owner");
    expect((await listMemberRows(s, repo.id)).map((m) => [m.principalId, m.role])).toEqual([
      [owner, "owner"],
    ]);
  });

  it("inserts the repo without a membership when the owner is no human principal", async () => {
    const s = store();
    const agent = await seedPrincipal(s, { kind: "agent" });
    for (const ownerId of [agent, "hu_missing", null]) {
      const repo = repoFixture({ claim: { status: "claimed", ownerId, expiresAt: null } });
      await s.insertRepo(repo);
      expect(await s.getRepo(repo.id)).not.toBeNull();
      expect(await listMemberRows(s, repo.id)).toEqual([]);
    }
  });

  it("claiming an unclaimed repo makes the claimer its owner member; later writes keep it", async () => {
    const s = store();
    const human = await seedPrincipal(s, { kind: "human" });
    const repo = repoFixture({
      claim: { status: "unclaimed", ownerId: null, expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    await s.insertRepo(repo);
    expect(await listMemberRows(s, repo.id)).toEqual([]);
    await s.updateRepo(repo.id, { claim: { status: "claimed", ownerId: human, expiresAt: null } });
    expect(await memberRole(s, repo.id, human)).toBe("owner");
    // An unrelated write (same owner) and a repeated claim are no-ops for membership.
    await s.updateRepo(repo.id, { deployTarget: "gf-x-api" });
    await s.updateRepo(repo.id, { claim: { status: "claimed", ownerId: human, expiresAt: null } });
    expect((await listMemberRows(s, repo.id)).length).toBe(1);
    expect((await s.getRepo(repo.id))?.deployTarget).toBe("gf-x-api");
  });
});
