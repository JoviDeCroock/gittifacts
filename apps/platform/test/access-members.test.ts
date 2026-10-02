/** The membership API: owners add/change/remove members, the last owner stays, everything audited. */
import { describe, expect, it } from "vitest";
import { world } from "./access-helpers.js";
import { addMember } from "./fixtures.js";
import { call, expectError, json, signUpHuman } from "./http.js";

interface Members {
  members: { principalId: string; name: string; email: string | null; role: string }[];
  viewerRole: string | null;
  canManage: boolean;
}

describe("repo members", () => {
  it("an owner adds by e-mail or principal id, changes roles; members see names, only owners e-mails", async () => {
    const w = await world();
    const alice = { cookie: w.alice.cookie };
    const path = `/api/v1/repos/${w.repo.id}/members`;
    const bobEmail = (
      await json<{ user: { email: string } }>(
        await call(w.app, "GET", "/api/v1/me", { cookie: w.bob.cookie }),
      )
    ).user.email;
    const added = await call(w.app, "POST", path, {
      ...alice,
      body: { email: bobEmail.toUpperCase(), role: "reviewer" },
    });
    expect(added.status).toBe(201);
    expect(await json(added)).toMatchObject({
      member: { principalId: w.bob.principal.id, role: "reviewer", email: bobEmail },
    });
    const carol = await signUpHuman(w.app, "Carol");
    const byId = await call(w.app, "POST", path, {
      ...alice,
      body: { principalId: carol.principal.id, role: "reader" },
    });
    expect(byId.status).toBe(201);
    const changed = await call(w.app, "POST", path, {
      ...alice,
      body: { principalId: carol.principal.id, role: "maintainer" },
    });
    expect(changed.status).toBe(200);

    const asOwner = await json<Members>(await call(w.app, "GET", path, alice));
    expect(asOwner.canManage).toBe(true);
    expect(asOwner.members.map((m) => [m.principalId, m.role])).toEqual([
      [w.alice.principal.id, "owner"],
      [w.bob.principal.id, "reviewer"],
      [carol.principal.id, "maintainer"],
    ]);
    expect(asOwner.members.every((m) => m.email !== null)).toBe(true);
    const asBob = await json<Members>(await call(w.app, "GET", path, { cookie: w.bob.cookie }));
    expect(asBob).toMatchObject({ viewerRole: "reviewer", canManage: false });
    expect(asBob.members.every((m) => m.email === null)).toBe(true);

    const audit = await json<{ events: { action: string }[] }>(
      await call(w.app, "GET", `/api/v1/audit?subject=repo:${w.repo.id}`, alice),
    );
    expect(audit.events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["repo.member-added", "repo.member-role-changed"]),
    );
  });

  it("only humans are members; unknown people are 404; non-owners and agents cannot manage", async () => {
    const w = await world();
    const path = `/api/v1/repos/${w.repo.id}/members`;
    const alice = { cookie: w.alice.cookie };
    await expectError(
      await call(w.app, "POST", path, {
        ...alice,
        body: { principalId: w.aliceAgent.principal.id, role: "owner" },
      }),
      404,
      "not-found",
    );
    await expectError(
      await call(w.app, "POST", path, {
        ...alice,
        body: { email: "nobody@example.com", role: "reader" },
      }),
      404,
      "not-found",
    );
    await expectError(
      await call(w.app, "POST", path, { ...alice, body: { role: "reader" } }),
      400,
      "invalid-request",
    );
    await addMember(w.s, w.repo.id, w.bob.principal.id, "maintainer");
    const carol = await signUpHuman(w.app, "Carol");
    await expectError(
      await call(w.app, "POST", path, {
        cookie: w.bob.cookie,
        body: { principalId: carol.principal.id, role: "reader" },
      }),
      403,
      "insufficient-role",
    );
    await expectError(
      await call(w.app, "DELETE", `${path}/${w.alice.principal.id}`, { cookie: w.bob.cookie }),
      403,
      "insufficient-role",
    );
    await expectError(
      await call(w.app, "POST", path, {
        token: w.aliceAgent.token,
        body: { principalId: carol.principal.id, role: "reader" },
      }),
      403,
      "forbidden",
    );
    // A member may leave.
    const left = await call(w.app, "DELETE", `${path}/${w.bob.principal.id}`, {
      cookie: w.bob.cookie,
    });
    expect(left.status).toBe(200);
    expect(
      (await call(w.app, "GET", `/api/v1/repos/${w.repo.id}`, { cookie: w.bob.cookie })).status,
    ).toBe(404);
  });

  it("the last owner can be neither removed nor demoted; with two owners either may go", async () => {
    const w = await world();
    const path = `/api/v1/repos/${w.repo.id}/members`;
    const alice = { cookie: w.alice.cookie };
    await expectError(
      await call(w.app, "DELETE", `${path}/${w.alice.principal.id}`, alice),
      409,
      "conflict",
    );
    await expectError(
      await call(w.app, "POST", path, {
        ...alice,
        body: { principalId: w.alice.principal.id, role: "maintainer" },
      }),
      409,
      "conflict",
    );
    await call(w.app, "POST", path, {
      ...alice,
      body: { principalId: w.bob.principal.id, role: "owner" },
    });
    const removed = await call(w.app, "DELETE", `${path}/${w.alice.principal.id}`, {
      cookie: w.bob.cookie,
    });
    expect(removed.status).toBe(200);
    const now = await json<Members>(await call(w.app, "GET", path, { cookie: w.bob.cookie }));
    expect(now.members.map((m) => [m.principalId, m.role])).toEqual([
      [w.bob.principal.id, "owner"],
    ]);
    await expectError(
      await call(w.app, "DELETE", `${path}/${w.bob.principal.id}`, { cookie: w.bob.cookie }),
      409,
      "conflict",
    );
    // Alice is out: her repo is gone for her (and her agent, which acts with her role).
    expect((await call(w.app, "GET", `/api/v1/repos/${w.repo.id}`, alice)).status).toBe(404);
    expect(
      (await call(w.app, "GET", `/api/v1/changes/${w.change.id}`, { token: w.aliceAgent.token }))
        .status,
    ).toBe(404);
  });
});
