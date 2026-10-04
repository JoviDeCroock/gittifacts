---
title: Ask for QA in a browser
nav: Ask for QA
description: On request, an agent tests the app built from a Change in a real browser against the Plan's acceptance criteria, with a screenshot of every step and a verdict per criterion.
order: 34
audience: both
group: Review
---

# Ask for QA in a browser

**You'll have:** a verdict for each acceptance criterion (pass, fail or couldn't test), a screenshot of every step, a replay, and the result signed into the Change's evidence.

QA runs only when someone asks. An agent opens the app built from the Change's current head in a real browser. It plans a short script for each acceptance criterion of the Plan, then runs it: it navigates, clicks, fills in fields and checks what the page shows. Without a Plan it checks that the affected pages load without errors.

QA is evidence. A failed criterion raises the lane to full review (Lane 2) and withdraws any approval of that head: the Change leaves the merge queue and needs a fresh approval. A criterion QA couldn't test raises the lane to at least quick review (Lane 1), because "couldn't test" is never a pass, but leaves approvals alone. QA never lowers a lane.

## 1. Ask

Ask when CI is green on the head, from any of these:

- **The Change page:** open the **QA in a browser** section and choose **Run QA**.
- **An agent:** call `request_qa({ changeId: "<changeId>" })`, then `get_qa({ changeId: "<changeId>" })` to read the result.
- **The CLI:** run `gittifacts qa <changeId> --wait`. It exits 0 when every criterion passed and 1 otherwise.
- **A GitHub pull request:** choose **Run QA** on the `gittifacts/lane` check run, or comment `/gittifacts qa`. You need write access to the repository; GitHub is asked again every time.

Asking twice for the same head returns the same run. To run it again, pass `force: true` or choose **Run QA again**.

## 2. Read the result

Each criterion shows its verdict and the reason. Under it, a strip of screenshots shows the page before the first step and after each step. Tap one to see it full size. The replay plays every step as an animated GIF.

On GitHub nothing new is posted. The result goes into the one summary comment as a QA line, with the criteria and up to four thumbnails folded under it, and into the check run. A comment that asked for QA gets an 👀 reaction.

<details>
<summary>What the agent can and can't reach</summary>

The app runs in the same sandbox as CI, from the head's build, with no internet. It never gets a public address: the browser asks the platform for every page and file, and the platform serves them from the sandbox. Requests to any other site are blocked and listed in the report. A criterion that needs another site, a login or an email is marked couldn't test.

Thumbnails on GitHub are signed links that expire after 72 hours. GitHub has to fetch images from a public address, and a GitHub App can't upload attachments. Full-size screenshots and the replay need a gittifacts sign-in with access to the repo.

</details>

<details>
<summary>Limits and cost</summary>

- At most 6 runs an hour and 30 a day per repo, and one at a time per Change.
- Each run has 5 minutes, 3 browser-minutes, up to 8 criteria and 10 steps per criterion.
- Model calls (about four per run) count against the Change's AI budget.
- A repo with no app to serve, such as a library, gets "nothing to test". That raises nothing.

</details>
