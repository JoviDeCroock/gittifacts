/**
 * Adding a member by e-mail trusts only a verified e-mail (security audit 2026-10-11, M3).
 *
 * E-mail sign-up doesn't prove the address (nothing is mailed). Mallory pre-registers Bob's work
 * e-mail; when the owner adds Bob by that e-mail, Mallory must not receive the role. An unverified
 * account's e-mail becomes an invite: the single-use link, handed to the person the owner means,
 * is the proof, and accepting it still needs a signed-in account with that e-mail. A verified
 * account (e.g. GitHub sign-in) is added directly.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { world } from "./access-helpers.js";
import { call, expectError, json, type TestApp } from "./http.js";

interface Members {
  members: { principalId: string; role: string }[];
  invites: { id: string; email: string; role: string }[];
}

let n = 0;
const fresh = (who: string) => `${who}${++n}-${Date.now()}@corp.example`;

/** Sign up with a chosen e-mail (unverified, like every e-mail sign-up); cookie and principal id. */
async function signUpAs(app: TestApp, email: string, name: string) {
  const res = await call(app, "POST", "/api/auth/sign-up/email", {
    body: { email, password: "correct-horse-battery-staple", name },
  });
  expect(res.status).toBe(200);
  const set = res.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
  const cookie = set!.split(";")[0]!;
  const me = await json<{ principal: { id: string } }>(
    await call(app, "GET", "/api/v1/me", { cookie }),
  );
  return { cookie, principalId: me.principal.id };
}

describe("adding a member by e-mail (M3: only verified e-mails resolve to an account)", () => {
  it("an account that pre-registered someone's e-mail gets an invite, not the role", async () => {
    const w = await world();
    const alice = { cookie: w.alice.cookie };
    const path = `/api/v1/repos/${w.repo.id}/members`;
    const bobEmail = fresh("bob");
    const mallory = await signUpAs(w.app, bobEmail, "Mallory");

    const res = await call(w.app, "POST", path, {
      ...alice,
      body: { email: bobEmail, role: "maintainer" },
    });
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ invite: { email: bobEmail, role: "maintainer" } });

    // Mallory is not a member and can't see the repo; the invite waits for whoever holds the link.
    const listed = await json<Members>(await call(w.app, "GET", path, alice));
    expect(listed.members.map((m) => m.principalId)).not.toContain(mallory.principalId);
    expect(listed.invites.map((i) => i.email)).toEqual([bobEmail]);
    await expectError(
      await call(w.app, "GET", `/api/v1/repos/${w.repo.id}`, { cookie: mallory.cookie }),
      404,
      "not-found",
    );
    const audit = await json<{ events: { action: string }[] }>(
      await call(w.app, "GET", `/api/v1/audit?subject=repo:${w.repo.id}`, alice),
    );
    expect(audit.events.map((e) => e.action)).toContain("member.invited");
    expect(audit.events.map((e) => e.action)).not.toContain("repo.member-added");
  });

  it("the person the owner hands the link to joins with their (unverified) account", async () => {
    const w = await world();
    const alice = { cookie: w.alice.cookie };
    const path = `/api/v1/repos/${w.repo.id}/members`;
    const email = fresh("ivy");
    const ivy = await signUpAs(w.app, email, "Ivy");
    const invited = await call(w.app, "POST", path, {
      ...alice,
      body: { email, role: "reviewer" },
    });
    expect(invited.status).toBe(202);
    const { inviteUrl } = await json<{ inviteUrl: string }>(invited);
    const token = inviteUrl.slice(inviteUrl.lastIndexOf("/") + 1);

    // The link alone admits nobody else (Bob is signed in with another e-mail).
    await expectError(
      await call(w.app, "POST", `/api/v1/invites/${token}/accept`, { cookie: w.bob.cookie }),
      403,
      "invite-email-mismatch",
    );
    const accepted = await call(w.app, "POST", `/api/v1/invites/${token}/accept`, {
      cookie: ivy.cookie,
    });
    expect(accepted.status).toBe(200);
    expect(await json(accepted)).toEqual({
      repoId: w.repo.id,
      role: "reviewer",
      alreadyMember: false,
    });
    const listed = await json<Members>(await call(w.app, "GET", path, alice));
    expect(listed.members).toContainEqual(
      expect.objectContaining({ principalId: ivy.principalId, role: "reviewer" }),
    );
  });

  it("a verified e-mail is added directly (and its open invite closes)", async () => {
    const w = await world();
    const alice = { cookie: w.alice.cookie };
    const path = `/api/v1/repos/${w.repo.id}/members`;
    const email = fresh("vera");
    const vera = await signUpAs(w.app, email, "Vera");
    expect(
      (await call(w.app, "POST", path, { ...alice, body: { email, role: "reader" } })).status,
    ).toBe(202);
    // As GitHub sign-in records it for a verified primary e-mail.
    await env.DB.prepare("UPDATE user SET email_verified = 1 WHERE email = ?").bind(email).run();
    const added = await call(w.app, "POST", path, { ...alice, body: { email, role: "reader" } });
    expect(added.status).toBe(201);
    expect(await json(added)).toMatchObject({
      member: { principalId: vera.principalId, role: "reader" },
    });
    expect((await json<Members>(await call(w.app, "GET", path, alice))).invites).toEqual([]);
  });
});
