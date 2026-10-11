/**
 * Journey 8: settings. Create (and revoke) an agent token; register a deploy integration in the
 * developer portal and install it through the real OAuth flow (PKCE) up to the redirect, where a
 * simulated third party receives the code (route-intercepted: there is no real deploy platform);
 * then the GitHub page. Secrets shown once are blurred in the video.
 */
import { GITHUB_SURFACES } from "../../../packages/domain/src/surfaces.js";
import { createHash, randomBytes } from "node:crypto";
import { HOST } from "../lib/journey.js";
import type { HumanJourney } from "../lib/types.js";

const BLUR =
  ".token__value, .secret-reveal__item:not(:first-child) .secret-box__value { filter: blur(7px); }";
const REDIRECT = "https://deploy.example/oauth/callback";

export const journey: HumanJourney = {
  number: "08",
  slug: "settings",
  title: "Settings: agent tokens, integrations, GitHub",
  subtitle:
    "Create and revoke an agent token; connect a deploy platform over OAuth; the GitHub page.",
  signedIn: true,
  async run(j, state) {
    const p = j.page;
    const blur = () => p.addStyleTag({ content: BLUR }).catch(() => {});
    const stamp = new Date().toISOString().slice(11, 16).replace(":", "");

    await j.chapter("Agents", "Agents: every MCP session, CLI login and token is its own agent");
    await j.goto("/agents", { waitFor: "h1", settleMs: 2000 });
    await blur();
    await j.snap("agents");
    await j.click(p.getByRole("button", { name: /Create agent and token/ }).first());
    await j.hold(700);
    await blur();
    const agentName = `journey-bot-${stamp}`;
    await j.type(p.getByLabel("Name").first(), agentName);
    await j.hold(600);
    await j.snap("agent-form");
    await j.click(
      p
        .locator("form")
        .getByRole("button", { name: /Create/ })
        .last(),
      { pauseMs: 300 },
    );
    await p.locator(".token__value").first().waitFor({ timeout: 20_000 });
    await blur();
    await j.caption("The token is shown once (blurred here)", 2600);
    await j.hold(3000);
    await j.snap("agent-token");
    await j.click(p.getByRole("button", { name: "I stored the token" }));
    await j.hold(1500);

    await j.chapter("Revoke it", "Revoke it: one click, every token it holds stops working");
    const row = p
      .locator("li.agent")
      .filter({ has: p.locator(".agent__name", { hasText: agentName }) })
      .first();
    await j.reveal(row, true);
    await j.click(row.getByRole("button", { name: /^Revoke/ }).first());
    await j.hold(900);
    await j.click(row.locator(".agent__confirm").getByRole("button", { name: /Revoke access/ }), {
      pauseMs: 300,
    });
    await p
      .getByText(/is revoked/)
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {});
    await j.hold(2200);
    await j.snap("agent-revoked");

    await j.chapter("Integrations", "Integrations: deploy platforms that connect to gittifacts");
    await j.goto("/settings/integrations", { waitFor: "h1", settleMs: 2000 });
    await j.snap("integrations");
    await j.goto("/settings/integrations/developer", { waitFor: "h1", settleMs: 1500 });
    await blur();
    await j.snap("developer");

    await j.chapter(
      "Register a deploy integration",
      "Developer portal: register a deploy platform (OAuth client)",
    );
    const open = p.getByRole("button", { name: /Register an integration/ }).first();
    if ((await open.count()) > 0) await j.click(open);
    await j.type(p.getByLabel("Name").first(), `Acme Deploy ${stamp}`);
    await j.type(p.getByLabel(/Homepage URL/).first(), "https://deploy.example");
    await j.type(p.getByLabel(/Redirect URIs/).first(), REDIRECT, 20);
    await j.snap("register-form");
    await j.click(p.getByRole("button", { name: "Register integration" }), { pauseMs: 300 });
    await p.locator(".secret-reveal").first().waitFor({ timeout: 20_000 });
    await blur();
    await j.hold(2600);
    await j.snap("registered");
    const clientId = ((await p.locator(".secret-box__value").first().textContent()) ?? "").trim();
    j.notes.push(`integration client ${clientId}`);
    state.integrationClientId = clientId;

    await j.chapter(
      "Install it (OAuth + PKCE)",
      "The deploy platform sends the person to authorize: pick repos, install",
    );
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await p.route(`${REDIRECT}*`, (r) => {
      const u = new URL(r.request().url());
      const rows = [...u.searchParams.entries()]
        .map(([k, v]) => `<tr><td>${k}</td><td>${k === "code" ? `${v.slice(0, 6)}…` : v}</td></tr>`)
        .join("");
      return r.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta name=viewport content="width=device-width"><body style="font:16px system-ui;margin:48px;background:#fffbea"><p style="font:600 12px monospace;color:#a3542b">SIMULATED THIRD PARTY (no real deploy platform in this recording)</p><h1>Acme Deploy received the install</h1><p>gittifacts redirected back with:</p><table cellpadding=6 style="font:14px monospace;border-collapse:collapse">${rows}</table><p>Next, Acme's server would exchange the code (with the PKCE verifier) for <code>gti_…</code> tokens.</p></body>`,
      });
    });
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "repo:read contents:read webhooks deployments:write",
      state: randomBytes(8).toString("hex"),
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${HOST}/api`,
    });
    await j.goto(`/api/oauth/authorize?${q}`, { waitFor: "h1", settleMs: 2600 });
    await j.snap("install");
    const selected = p.getByRole("radio", { name: /[Ss]elected/ }).first();
    if ((await selected.count()) > 0) await j.click(selected);
    const repo = p
      .getByRole("checkbox", { name: new RegExp(String(state.projectName ?? "journey-mcp")) })
      .first();
    if ((await repo.count()) > 0) await j.click(repo);
    await j.hold(1200);
    await j.snap("install-picked");
    await j.click(p.getByRole("button", { name: /Install & authorize/ }), { pauseMs: 300 });
    await p.waitForURL(/deploy\.example/, { timeout: 20_000 }).catch(() => {});
    await j.hold(3200);
    await j.snap("callback");

    await j.chapter(
      "Installed",
      "Back in Settings → Integrations: the installation and what it may do",
    );
    await j.goto("/settings/integrations", { waitFor: "h1", settleMs: 2400 });
    await j.snap("integrations-installed");
    await j.scroll(400, 900);
    await j.hold(1800);

    // GitHub surfaces off (packages/domain/src/surfaces.ts): no GitHub settings page to record.
    if (!GITHUB_SURFACES) return;
    await j.chapter("GitHub", "Settings → GitHub: connect a GitHub App (empty state)");
    await j.goto("/settings/github", { waitFor: "h1", settleMs: 2400 });
    await j.snap("github");
    await j.scroll(600, 1200);
    await j.hold(2400);
    await j.snap("github-2");
  },
};
