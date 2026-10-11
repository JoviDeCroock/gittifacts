/**
 * Account and team onboarding in the browser (DECISIONS 2026-10-11):
 *
 * - An owner adds an e-mail nobody has signed up with: the invite link shows once; the invitee
 *   opens it signed out, creates an account with that e-mail, comes straight back and joins; the
 *   owner sees the new member and no open invite. A second invite is revoked from the list.
 * - Password reset: the gate's server has no outbound e-mail (like production today), so sign-in
 *   offers no "Forgot password?" and /forgot-password says why. The configured screens are driven
 *   with the server's answers stubbed (the workerd test password-reset.test.ts runs the real ones).
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";
import { uniqueName } from "../../lib/poll.js";

test.describe("member invites", () => {
  test("invite someone without an account; they sign up from the link and join", async ({
    authed: page,
    world,
    browser,
    baseURL,
  }) => {
    await page.goto(`/repos/${world.repoId}/members`);
    const form = page.locator("form.add-member");
    const invitee = `${uniqueName("invitee")}@e2e.invalid`;
    await form.getByLabel("E-mail").fill(invitee);
    await form.getByRole("button", { name: "Add" }).click();
    const once = page.locator(".invite-once");
    await expect(once).toContainText(`Send ${invitee} this link to join`);
    const link = (await once.locator("code").innerText()).replace(/\s+/g, "");
    expect(link).toMatch(/\/invite\/gtm_[A-Za-z0-9_-]{43}$/);
    const invited = page.locator("section.invites");
    await expect(invited.getByText(invitee)).toBeVisible();
    await expectNoHorizontalScroll(page);

    // The invitee, signed out, in their own browser.
    const ctx = await browser.newContext({ baseURL });
    const them = await ctx.newPage();
    await them.goto(new URL(link).pathname);
    await expect(
      them.getByRole("heading", { level: 1, name: `Join ${world.repoName}` }),
    ).toBeVisible();
    await expect(them.getByText(`${invitee.slice(0, 2)}•••@e2e.invalid`)).toBeVisible();
    await them.getByRole("link", { name: "Create an account" }).click();
    await expect(them).toHaveURL(/\/signin\?mode=signup&next=/);
    const signup = them.locator("form").filter({ has: them.locator('input[type="password"]') });
    await signup.getByLabel("Name").fill("Ivy Invitee");
    await signup.getByLabel("Email").fill(invitee);
    await signup.getByLabel("Password").fill("pw-invitee-correct-horse");
    await signup.getByRole("button", { name: "Create account" }).click();
    await expect(them).toHaveURL(new RegExp(`${new URL(link).pathname}$`));
    await them.getByRole("button", { name: "Join as a reviewer" }).click();
    await expect(
      them.getByRole("heading", { level: 1, name: `You're a reviewer of ${world.repoName}` }),
    ).toBeVisible();
    await them.getByRole("link", { name: "Open the repo" }).click();
    await expect(them).toHaveURL(new RegExp(`/repos/${world.repoId}$`));
    await ctx.close();

    await page.reload();
    await expect(
      page.locator(".members__list .member__name", { hasText: "Ivy Invitee" }),
    ).toBeVisible();
    await expect(page.locator("section.invites")).toHaveCount(0);

    // A second invite, revoked: its row goes.
    const other = `${uniqueName("revoked")}@e2e.invalid`;
    await form.getByLabel("E-mail").fill(other);
    await form.getByRole("button", { name: "Add" }).click();
    const row = page.locator("section.invites li").filter({ hasText: other });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(row).toHaveCount(0);
  });

  test("an unknown invite link is a page, not a crash", async ({ page }) => {
    await page.goto(`/invite/gtm_${"A".repeat(43)}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "This invite link doesn't work" }),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe("password reset", () => {
  test("without outbound e-mail: no forgot-password link, and the page says why", async ({
    page,
  }) => {
    await page.goto("/signin");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // The options answer has arrived before we look for the link's absence.
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await (await fetch("/api/v1/sign-in-options")).json()).passwordReset,
        ),
      )
      .toBe(false);
    await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveCount(0);
    await page.goto("/forgot-password");
    await expect(
      page.getByRole("heading", { level: 1, name: "Password reset isn't available here" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to sign in" })).toBeVisible();
  });

  test("with e-mail configured: forgot, check your e-mail, choose a new password", async ({
    page,
  }) => {
    await page.route("**/api/v1/sign-in-options", (r) =>
      r.fulfill({ json: { passwordReset: true } }),
    );
    let asked: unknown = null;
    await page.route("**/api/auth/request-password-reset", async (r) => {
      asked = r.request().postDataJSON();
      await r.fulfill({ json: { status: true } });
    });
    await page.route("**/api/auth/reset-password", (r) => r.fulfill({ json: { status: true } }));

    await page.goto("/signin");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.getByLabel("Email").fill("rita@e2e.invalid");
    await page.getByRole("button", { name: "Send the reset link" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Check your e-mail" })).toBeVisible();
    expect(asked).toMatchObject({
      email: "rita@e2e.invalid",
      redirectTo: expect.stringMatching(/\/reset-password$/),
    });

    await page.goto("/reset-password?token=stubbed-token");
    await page.getByLabel("New password", { exact: true }).fill("short");
    await page.getByRole("button", { name: "Save the new password" }).click();
    await expect(page.getByRole("alert")).toContainText("at least 8 characters");
    await page.getByLabel("New password", { exact: true }).fill("a-brand-new-password-42");
    await page.getByRole("button", { name: "Save the new password" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Your password is changed" }),
    ).toBeVisible();

    await page.goto("/reset-password?error=INVALID_TOKEN");
    await expect(
      page.getByRole("heading", { level: 1, name: "This reset link doesn't work" }),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
