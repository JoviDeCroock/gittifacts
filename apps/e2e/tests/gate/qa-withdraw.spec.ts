/**
 * A QA failure after approval withdraws the approval (user decision): the owner approves an
 * agent's Change (the queue frozen so it waits there), QA fails on it, and the Change page says
 * whose approval was withdrawn; the Change leaves the queue and is graded again for a fresh one.
 */
import { expect, expectNoHorizontalScroll, test } from "../../lib/fixtures.js";
import { pollUntil } from "../../lib/poll.js";
import { seedCall } from "../../lib/world.js";

test("QA failure after approval: the approval is withdrawn and shown on the Change page", async ({
  authed: page,
  agentWork,
  request,
  baseURL,
  human,
}) => {
  const headers = { cookie: human.cookie, origin: baseURL as string };
  const status = async () =>
    (
      (await (
        await request.get(`${baseURL}/api/v1/changes/${agentWork.changeId}`, { headers })
      ).json()) as { change: { status: string } }
    ).change.status;
  expect(
    (
      await request.post(`${baseURL}/api/v1/repos/${agentWork.repoId}/queue/freeze`, {
        headers,
        data: { reason: "e2e: QA withdraw" },
      })
    ).status(),
  ).toBe(200);
  await page.goto(`/changes/${agentWork.changeId}`);
  const approve = page.getByTestId("decision-approve").first();
  await approve.scrollIntoViewIfNeeded();
  await approve.click();
  await page.getByTestId("decision-confirm").click();
  await pollUntil(status, (s) => s === "queued", {
    timeoutMs: 20_000,
    what: "the approved Change to wait in the frozen queue",
  });

  await seedCall(request, baseURL as string, "/__e2e/qa/fail", { changeId: agentWork.changeId });
  const asked = await request.post(`${baseURL}/api/v1/changes/${agentWork.changeId}/qa`, {
    headers,
    data: {},
  });
  expect(asked.status()).toBe(202);
  await pollUntil(
    async () =>
      (
        (await (
          await request.get(`${baseURL}/api/v1/changes/${agentWork.changeId}/qa`, { headers })
        ).json()) as { runs: Array<{ status: string }> }
      ).runs[0]?.status,
    (s) => s === "done",
    { timeoutMs: 45_000, what: "the QA run to finish" },
  );
  // The Change left the queue and is graded again (running → awaiting review), never merged.
  await pollUntil(status, (s) => s === "running" || s === "awaiting-review", {
    timeoutMs: 20_000,
    what: "the Change to be graded again",
  });

  await page.reload();
  const qa = page.getByTestId("qa");
  await qa.scrollIntoViewIfNeeded();
  await expect(qa).toHaveAttribute("data-status", "done");
  await expect(qa.getByTestId("qa-criterion").first()).toHaveAttribute("data-verdict", "fail");
  await expect(qa.getByTestId("qa-withdrawn")).toBeVisible();
  await expectNoHorizontalScroll(page);
});
