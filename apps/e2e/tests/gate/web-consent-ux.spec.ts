/**
 * Signing an agent in, from the person's side: sign-in says what it is for when it carries a
 * `next` (a claim link, a CLI login), the consent screen names who is approving, and the name the
 * person gives the agent at consent is the name the receipt and /agents show. Real Worker, real
 * better-auth device flow (RFC 8628), run in the desktop and phone projects.
 */
import type { APIRequestContext } from "@playwright/test";
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";
import { pollUntil, uniqueName } from "../../lib/poll.js";

/** A CLI login waiting for a person: what `gittifacts login` asks the platform for. */
async function deviceCode(request: APIRequestContext, baseURL: string): Promise<{ user: string; device: string }> {
  const res = await request.post(`${baseURL}/api/auth/device/code`, {
    form: { client_id: "gittifacts-cli", scope: "repo:read change:create" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { user_code?: unknown; device_code?: unknown };
  expect(typeof body.user_code).toBe("string");
  expect(typeof body.device_code).toBe("string");
  return { user: body.user_code as string, device: body.device_code as string };
}

/** The CLI's poll (RFC 8628): the agent principal is minted when the token is issued. */
async function redeem(request: APIRequestContext, baseURL: string, device: string): Promise<void> {
  await pollUntil(
    async () => {
      const res = await request.post(`${baseURL}/api/oauth/token`, {
        form: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device, client_id: "gittifacts-cli" },
      });
      return (await res.json()) as { access_token?: string; error?: string };
    },
    (t) => typeof t.access_token === "string" || (t.error !== undefined && t.error !== "authorization_pending" && t.error !== "slow_down"),
    { timeoutMs: 30_000, what: "the CLI's token after approval", minIntervalMs: 1_000 },
  ).then((t) => expect(t.access_token, JSON.stringify(t)).toBeTruthy());
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test.describe("sign-in carries its context", () => {
  test("a claim link: the heading says claim, and an agent is offered its own way in", async ({ page }) => {
    await page.goto(`/signin?next=${encodeURIComponent("/claim/gtc_does_not_exist")}`);
    await expect(page.getByTestId("signin-title")).toHaveText(/^Sign in to claim /);
    await expect(page.getByTestId("signin-agent")).toContainText("/start");
    await expectNoHorizontalScroll(page);
  });

  test("a CLI login: the heading says the CLI is waiting", async ({ page }) => {
    await page.goto(`/signin?next=${encodeURIComponent("/device?user_code=ABCD-2345")}`);
    await expect(page.getByTestId("signin-title")).toHaveText("Sign in to connect the CLI");
  });
});

test("CLI consent names the approver, and the agent's name is the one the person gave", async ({ authed: page, playwright, baseURL, human, world }) => {
  // The CLI's own HTTP client: no browser session. (The shared request context carries the
  // person's cookie from sign-up, and better-auth then wants an Origin as from a browser.)
  const cli = await playwright.request.newContext();
  const code = await deviceCode(cli, baseURL as string);
  await page.goto(`/device?user_code=${encodeURIComponent(code.user)}`);

  // Who is approving is on screen before anything is granted, with a way to switch accounts.
  const approver = page.getByTestId("consent-approver");
  await expect(approver).toContainText(human.name);
  await expect(approver.getByRole("button", { name: "Switch account" })).toBeVisible();

  const agentName = uniqueName("laptop-cli");
  const nameField = page.getByTestId("consent-agent-name");
  await nameField.fill(agentName);
  await page.getByRole("checkbox", { name: new RegExp(`${escape(world.repoName)}$`) }).check();
  await expectNoHorizontalScroll(page);

  await page.getByRole("button", { name: /^Allow / }).click();

  // The flow ends deliberately: a receipt, focus on its heading, the tab title says so.
  const outcome = page.getByTestId("consent-outcome");
  await expect(outcome).toBeVisible();
  await expect(page.getByTestId("consent-receipt-name")).toHaveText(agentName);
  await expect(page.getByTestId("consent-receipt")).toContainText(world.repoName);
  await expect(page.getByTestId("consent-receipt")).toContainText(human.name);
  await expect(outcome.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(page).toHaveTitle(/gittifacts/);

  await redeem(cli, baseURL as string, code.device);
  await cli.dispose();
  await page.goto("/agents");
  const row = page.getByTestId("agent-row").filter({ hasText: agentName });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("agent-status")).toHaveAttribute("data-status", "active");
});
