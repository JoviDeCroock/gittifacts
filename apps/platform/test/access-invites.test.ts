/**
 * Member invites: an owner adds an e-mail nobody has signed up with and gets a single-use link;
 * the person signs up with that e-mail and accepts; the link plus the matching e-mail are both
 * needed; owners list and revoke open invites; everything is audited.
 */
import { describe, expect, it } from "vitest";
import { world } from "./access-helpers.js";
import { addMember } from "./fixtures.js";
import { call, expectError, json, type TestApp } from "./http.js";

interface Invited {
  invite: { id: string; email: string; role: string; expired: boolean };
  inviteUrl: string;
}
interface Members {
  members: { principalId: string; role: string }[];
  invites: { id: string; email: string }[];
}

let n = 0;
/** Sign up with a chosen e-mail; the session cookie. */
async function signUpAs(app: TestApp, email: string, name = "Invitee"): Promise<string> {
  const res = await call(app, "POST", "/api/auth/sign-up/email", {
    body: { email, password: "correct-horse-battery-staple", name },
  });
  expect(res.status).toBe(200);
  const set = res.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
  return set!.split(";")[0]!;
}

const fresh = () => `invitee${++n}-${Date.now()}@example.com`;
const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

describe("member invites", () => {
  it("an unknown e-mail gets a one-time link; that person signs up, opens it and joins", async () => {
    const w = await world();
    const alice = { cookie: w.alice.cookie };
    const email = fresh();
    const res = await call(w.app, "POST", `/api/v1/repos/${w.repo.id}/members`, {
      ...alice,
      body: { email: email.toUpperCase(), role: "reviewer" },
    });
    expect(res.status).toBe(202);
    const { invite, inviteUrl } = await json<Invited>(res);
    expect(invite).toMatchObject({ email, role: "reviewer", expired: false });
    expect(inviteUrl).toMatch(/^http:\/\/localhost\/invite\/gtm_[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(inviteUrl);

    // Owners see it pending; the link is never listed again.
    const listed = await json<Members>(
      await call(w.app, "GET", `/api/v1/repos/${w.repo.id}/members`, alice),
    );
    expect(listed.invites.map((i) => i.email)).toEqual([email]);
    expect(JSON.stringify(listed)).not.toContain(token);
    await addMember(w.s, w.repo.id, w.bob.principal.id, "reader");
    const asBob = await json<Members>(
      await call(w.app, "GET", `/api/v1/repos/${w.repo.id}/members`, { cookie: w.bob.cookie }),
    );
    expect(asBob.invites).toEqual([]);

    // Signed out, the link says what it is for, with the e-mail partly hidden.
    const anon = await json<Record<string, unknown>>(
      await call(w.app, "GET", `/api/v1/invites/${token}`),
    );
    expect(anon).toMatchObject({
      status: "pending",
      repo: { id: w.repo.id },
      role: "reviewer",
      invitedBy: { name: "Alice" },
      viewer: { signedIn: false, emailMatches: false, role: null },
    });
    expect(anon.emailHint).toBe(`${email.slice(0, 2)}•••@example.com`);
    await expectError(
      await call(w.app, "POST", `/api/v1/invites/${token}/accept`),
      401,
      "unauthorized",
    );
    await expectError(
      await call(w.app, "POST", `/api/v1/invites/${token}/accept`, {
        headers: { "idempotency-key": "k-anon" },
      }),
      401,
      "unauthorized",
    );

    // Someone else holding the link cannot use it.
    await expectError(
      await call(w.app, "POST", `/api/v1/invites/${token}/accept`, { cookie: w.bob.cookie }),
      403,
      "invite-email-mismatch",
    );

    const cookie = await signUpAs(w.app, email);
    const mine = await json<{ viewer: { emailMatches: boolean } }>(
      await call(w.app, "GET", `/api/v1/invites/${token}`, { cookie }),
    );
    expect(mine.viewer.emailMatches).toBe(true);
    // Signing up alone grants nothing: e-mail sign-up does not prove the address.
    expect((await call(w.app, "GET", `/api/v1/repos/${w.repo.id}`, { cookie })).status).toBe(404);
    // As the web page sends it: with an Idempotency-Key.
    const accepted = await call(w.app, "POST", `/api/v1/invites/${token}/accept`, {
      cookie,
      headers: { "idempotency-key": `accept-${token.slice(4, 16)}` },
    });
    expect(accepted.status).toBe(200);
    expect(await json(accepted)).toEqual({
      repoId: w.repo.id,
      role: "reviewer",
      alreadyMember: false,
    });
    expect((await call(w.app, "GET", `/api/v1/repos/${w.repo.id}`, { cookie })).status).toBe(200);

    // Single use: the accepter sees it done; the link is closed for anyone else.
    const again = await call(w.app, "POST", `/api/v1/invites/${token}/accept`, { cookie });
    expect(await json(again)).toMatchObject({ alreadyMember: true });
    await expectError(
      await call(w.app, "POST", `/api/v1/invites/${token}/accept`, { cookie: w.bob.cookie }),
      409,
      "invite-closed",
    );
    const after = await json<Members>(
      await call(w.app, "GET", `/api/v1/repos/${w.repo.id}/members`, alice),
    );
    expect(after.invites).toEqual([]);
    expect(after.members.map((m) => m.role)).toEqual(["owner", "reader", "reviewer"]);

    const audit = await json<{ events: { action: string; payload: Record<string, unknown> }[] }>(
      await call(w.app, "GET", `/api/v1/audit?subject=repo:${w.repo.id}`, alice),
    );
    const actions = audit.events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["member.invited", "member.invite-accepted"]));
    expect(JSON.stringify(audit)).not.toContain(email);
  });

  it("owners revoke an invite; inviting again replaces the link; bad links are 404", async () => {
    const w = await world();
    const alice = { cookie: w.alice.cookie };
    const path = `/api/v1/repos/${w.repo.id}/members`;
    const email = fresh();
    const first = await json<Invited>(
      await call(w.app, "POST", path, { ...alice, body: { email, role: "reader" } }),
    );
    const second = await json<Invited>(
      await call(w.app, "POST", path, { ...alice, body: { email, role: "maintainer" } }),
    );
    expect(
      (await json<Members>(await call(w.app, "GET", path, alice))).invites.map((i) => i.id),
    ).toEqual([second.invite.id]);
    const firstView = await json<{ status: string }>(
      await call(w.app, "GET", `/api/v1/invites/${tokenOf(first.inviteUrl)}`),
    );
    expect(firstView.status).toBe("revoked");

    // Non-owners and agents cannot invite or revoke.
    await expectError(
      await call(w.app, "POST", path, {
        cookie: w.bob.cookie,
        body: { email: fresh(), role: "reader" },
      }),
      404,
      "not-found",
    );
    await expectError(
      await call(w.app, "POST", path, {
        token: w.aliceAgent.token,
        body: { email: fresh(), role: "reader" },
      }),
      403,
      "forbidden",
    );
    const inv = `/api/v1/repos/${w.repo.id}/invites/${second.invite.id}`;
    await expectError(
      await call(w.app, "DELETE", inv, { token: w.aliceAgent.token }),
      403,
      "forbidden",
    );

    expect((await call(w.app, "DELETE", inv, alice)).status).toBe(200);
    await expectError(await call(w.app, "DELETE", inv, alice), 404, "not-found");
    const cookie = await signUpAs(w.app, email);
    await expectError(
      await call(w.app, "POST", `/api/v1/invites/${tokenOf(second.inviteUrl)}/accept`, { cookie }),
      409,
      "invite-closed",
    );
    await expectError(await call(w.app, "GET", "/api/v1/invites/gtm_nope"), 404, "not-found");
    await expectError(
      await call(w.app, "GET", `/api/v1/invites/gtm_${"A".repeat(43)}`),
      404,
      "not-found",
    );
    const audit = await json<{ events: { action: string }[] }>(
      await call(w.app, "GET", `/api/v1/audit?subject=repo:${w.repo.id}`, alice),
    );
    expect(audit.events.map((e) => e.action)).toContain("member.invite-revoked");
  });

  it("an invite stops working once its sender is no longer an owner", async () => {
    const w = await world();
    const path = `/api/v1/repos/${w.repo.id}/members`;
    // Bob becomes an owner, invites someone, then Alice demotes him.
    await call(w.app, "POST", path, {
      cookie: w.alice.cookie,
      body: { principalId: w.bob.principal.id, role: "owner" },
    });
    const email = fresh();
    const { inviteUrl } = await json<Invited>(
      await call(w.app, "POST", path, { cookie: w.bob.cookie, body: { email, role: "owner" } }),
    );
    await call(w.app, "POST", path, {
      cookie: w.alice.cookie,
      body: { principalId: w.bob.principal.id, role: "reader" },
    });
    const cookie = await signUpAs(w.app, email);
    await expectError(
      await call(w.app, "POST", `/api/v1/invites/${tokenOf(inviteUrl)}/accept`, { cookie }),
      409,
      "invite-closed",
    );
  });
});
