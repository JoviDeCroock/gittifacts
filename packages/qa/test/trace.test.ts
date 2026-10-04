import { describe, expect, it } from "vitest";
import { numbersIn, quotesIn, traceStep, wordsIn } from "../src/index.js";

const three = "Entering 100 for 3 people and pressing Split lists exactly three shares";
const total =
  "The shares add up exactly to the amount: 100 split between 3 people shows a total of €100.00";
const none =
  'Splitting between 0 people shows the message "Enter at least one person." and no shares';

describe("traceability (deterministic; only traced expectations decide)", () => {
  it("reads numbers as values, quoted strings and content words", () => {
    expect(numbersIn("€1,234.50 for three")).toEqual([1234.5, 3]);
    expect(quotesIn(none)).toEqual(["Enter at least one person."]);
    expect(wordsIn("Lists the shares")).toEqual(["list", "share"]);
  });

  it("a count or an amount the criterion states traces; a value it never states doesn't", () => {
    expect(
      traceStep(three, { action: "expect_count", target: "#shares li", value: "3" }).traced,
    ).toBe(true);
    expect(traceStep(three, { action: "expect_text", value: "€33.34" })).toMatchObject({
      traced: false,
      why: "33.34 is not in the criterion",
    });
    expect(traceStep(total, { action: "expect_text", value: "Total: €100.00" }).traced).toBe(true);
    expect(traceStep(total, { action: "expect_count", value: "4", target: "li" }).traced).toBe(
      false,
    );
  });

  it("text traces through a quoted string or the criterion's own words; selectors and URLs through words", () => {
    expect(
      traceStep(none, { action: "expect_text", value: "Enter at least one person." }).traced,
    ).toBe(true);
    expect(
      traceStep(none, { action: "expect_no_text", target: "#shares", value: "Person 4" }).traced,
    ).toBe(false);
    expect(
      traceStep("Typing a name greets the person by name", {
        action: "expect_text",
        value: "Hello Ada",
      }).traced,
    ).toBe(false);
    expect(traceStep(three, { action: "expect_visible", target: "#shares" }).traced).toBe(true);
    expect(traceStep(three, { action: "expect_visible", target: "#footer" }).traced).toBe(false);
    expect(
      traceStep("Saving opens the settings page", { action: "expect_url", value: "/settings" })
        .traced,
    ).toBe(true);
    expect(traceStep(three, { action: "click", target: "#whatever" }).traced).toBe(true); // actions aren't subject
  });
});
