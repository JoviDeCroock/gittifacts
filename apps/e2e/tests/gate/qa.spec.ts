/**
 * QA on request, end to end through the real Worker: an agent's Change awaiting review → the human
 * presses Run QA on the Change page → the QaRunWorkflow boots the head privately (the entry's fake
 * container), drives it (the entry's HTML browser over the production private path; no Plan, so the
 * smoke check, no model) → the page shows the verdict and the step screenshots, the signed qa-run
 * item is in the head's evidence, and asking again is the same run.
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";
import { pollUntil } from "../../lib/poll.js";

test("QA on request: Run QA → a verdict with screenshots, signed into the evidence", async ({
  authed: page,
  agentWork,
  request,
  baseURL,
  human,
}) => {
  await page.goto(`/changes/${agentWork.changeId}`);
  const qa = page.getByTestId("qa");
  await qa.scrollIntoViewIfNeeded();
  await expect(qa).toHaveAttribute("data-status", "none");
  await qa.getByTestId("qa-run").click();

  // The run finishes on its own; the panel polls and shows the result.
  await expect(qa).toHaveAttribute("data-status", "done", { timeout: 45_000 });
  const criterion = qa.getByTestId("qa-criterion").first();
  await expect(criterion).toHaveAttribute("data-verdict", "pass");
  await expect(criterion.locator("img").first()).toBeVisible();
  await expectNoHorizontalScroll(page);

  // The API agrees, the item is signed into the head's evidence, and asking again is the same run.
  const headers = { cookie: human.cookie, origin: baseURL as string };
  const runs = await pollUntil(
    async () =>
      (
        (await (
          await request.get(`${baseURL}/api/v1/changes/${agentWork.changeId}/qa`, { headers })
        ).json()) as { runs: Array<{ id: string; status: string; headSha: string }> }
      ).runs,
    (r) => r[0]?.status === "done",
    { timeoutMs: 10_000, what: "the QA run to be done over the API" },
  );
  expect(runs[0]?.headSha).toBe(agentWork.head);
  const ev = (await (
    await request.get(`${baseURL}/api/v1/changes/${agentWork.changeId}/evidence`, { headers })
  ).json()) as {
    evidence: { items: Array<{ kind: string }> };
    verification: { ok: boolean };
  };
  expect(ev.verification.ok).toBe(true);
  expect(ev.evidence.items.map((i) => i.kind)).toContain("qa-run");
  const again = await request.post(`${baseURL}/api/v1/changes/${agentWork.changeId}/qa`, {
    headers,
    data: {},
  });
  expect(again.status()).toBe(202);
  expect(await again.json()).toMatchObject({ reused: true, run: { id: runs[0]?.id } });
});
