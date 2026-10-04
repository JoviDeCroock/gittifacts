/**
 * Journey 2: an agent created an unclaimed project and handed over its claim link. The human opens
 * it signed out, signs in (desktop) or creates an account (phone), passes Turnstile and claims it.
 * Headed Chromium: Turnstile refuses headless browsers.
 *
 * state.json: claimUrl (desktop), claimUrlMobile (phone), human { email, password } (desktop),
 * newHuman { name, email, password } (phone).
 */
import type { HumanJourney } from "../lib/types.js";

export const journey: HumanJourney = {
  number: "02",
  slug: "claim",
  title: "Claim a project an agent created",
  subtitle:
    "An agent made an unclaimed project with no account and sent its claim link. A person claims it.",
  mobile: true,
  headed: true,
  async run(j, state, { mobile }) {
    const p = j.page;
    const url = mobile ? state.claimUrlMobile : state.claimUrl;
    if (!url) throw new Error(`state.${mobile ? "claimUrlMobile" : "claimUrl"} is missing`);

    await j.chapter(
      "Open the claim link",
      "The agent's message: “claim it here” → the claim link, signed out",
    );
    j.metrics.claimPageLoadMs = await j.goto(url, { waitFor: "h1", settleMs: 1800 });
    await j.snap("claim-signed-out");
    await j.reveal(p.locator("#claim-does"), true);
    await j.hold(2200);
    await j.reveal(p.locator("#claim-limits"), true);
    await j.hold(2000);
    await j.snap("claim-limits");

    await j.chapter("Sign in", mobile ? "No account yet: create one" : "Sign in to claim");
    await j.click(p.getByRole("link", { name: "Sign in to claim" }));
    await p.waitForURL(/\/signin/, { timeout: 15_000 });
    await j.hold(1200);
    await j.snap("signin");
    if (mobile) {
      const who = state.newHuman;
      if (!who) throw new Error("state.newHuman is missing");
      await j.click(p.getByRole("button", { name: "Create an account" }));
      await j.hold(700);
      await j.snap("signup");
      await j.type(p.getByLabel("Name"), who.name);
      await j.type(p.getByLabel("Email"), who.email);
      await j.type(p.getByLabel("Password"), who.password, 20);
      const started = Date.now();
      await j.click(p.getByRole("button", { name: "Create account" }));
      await p.waitForURL(/\/claim\//, { timeout: 30_000 });
      j.metrics.signUpToClaimPageMs = Date.now() - started;
    } else {
      const who = state.human;
      if (!who) throw new Error("state.human is missing");
      await j.type(p.getByLabel("Email"), who.email);
      await j.type(p.getByLabel("Password"), who.password, 20);
      const started = Date.now();
      await j.click(p.getByRole("button", { name: "Sign in", exact: true }));
      await p.waitForURL(/\/claim\//, { timeout: 30_000 });
      j.metrics.signInToClaimPageMs = Date.now() - started;
    }
    await p.waitForSelector("#claim-decide", { timeout: 20_000 });
    await j.hold(1200);

    await j.chapter(
      "Human check + claim",
      "Back on the claim page, signed in: Turnstile, then claim",
    );
    await j.reveal(p.locator("#claim-decide"), true);
    await j.hold(800);
    // Turnstile usually passes on its own in a real browser; click its box if it asks.
    const claimBtn = p.getByRole("button", { name: "Claim this repo" });
    const started = Date.now();
    for (let i = 0; i < 60 && (await claimBtn.isDisabled()); i++) {
      // The checkbox sits in a closed shadow root: click where it is drawn (left edge of the widget).
      if (i === 4 || i === 30) {
        const box = await p
          .locator(".turnstile__host")
          .first()
          .boundingBox()
          .catch(() => null);
        if (box) {
          await j.moveTo(box.x + 21, box.y + box.height / 2);
          await j.hold(200);
          await p.mouse.click(box.x + 21, box.y + box.height / 2);
          j.notes.push(
            `clicked the Turnstile checkbox at ${Math.round((Date.now() - started) / 100) / 10}s`,
          );
        }
      }
      await j.hold(500);
    }
    j.metrics.turnstileMs = Date.now() - started;
    await j.snap("claim-ready");
    const clickAt = Date.now();
    await j.click(claimBtn, { pauseMs: 200 });
    await p
      .getByText(/Open the project/)
      .first()
      .waitFor({ timeout: 30_000 });
    j.metrics.claimMs = Date.now() - clickAt;
    await j.hold(1800);
    await j.snap("claimed");

    await j.chapter(
      "The project, now yours",
      "Claimed: the person is the owner; the project no longer expires",
    );
    await j.click(p.getByText(/Open the project/).first());
    await p.waitForURL(/\/repos\//, { timeout: 20_000 });
    await p.waitForLoadState("networkidle").catch(() => {});
    await j.hold(2500);
    await j.snap("repo");
    await j.scroll(600, 1200);
    await j.hold(1800);
    await j.snap("repo-2");
  },
};
