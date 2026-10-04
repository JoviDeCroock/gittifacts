/**
 * The Plans of fixtures/<name>/fixture.json, generated (keep in sync; scenarios.test.ts checks).
 * Scenarios use these, never a placeholder: the live contract run drafts real Plans from the
 * same fixtures, and a live judge reads every acceptance criterion.
 */
interface FixturePlan {
  title: string;
  intent: string;
  acceptanceCriteria: string[];
  outOfScope: string[];
  riskDeclarations: { area: string; description: string }[];
  scopePaths: string[];
}

export const FIXTURE_PLANS = {
  "pure-bugfix-with-regression-test": {
    title: "Fix allocate() losing a minor unit on uneven splits",
    intent:
      "allocate() promises shares that add up to exactly the total, but when the total does not divide evenly it drops one minor unit: splitting EUR 1.00 three ways returns 33 + 33 + 33 cents. Hand out every leftover minor unit, first share first, and pin the behaviour with a regression test.",
    acceptanceCriteria: [
      'allocate(money(100, "EUR"), [1, 1, 1]) returns 34, 33 and 33 cents',
      "For any total (including negative totals) and valid ratios, the shares sum to exactly the total",
      "A regression test fails before the fix and passes after it",
      "Results for evenly divisible totals are unchanged",
    ],
    outOfScope: [
      "Switching to a largest-remainder distribution strategy",
      "Changes to any module other than allocate",
    ],
    riskDeclarations: [],
    scopePaths: ["src/allocate.ts", "test/allocate.test.ts"],
  },
  "bugfix-without-test": {
    title: "Fix allocate() losing a minor unit on uneven splits",
    intent:
      "allocate() promises shares that add up to exactly the total, but when the total does not divide evenly it drops one minor unit: splitting EUR 1.00 three ways returns 33 + 33 + 33 cents. Hand out every leftover minor unit, first share first, and pin the behaviour with a regression test.",
    acceptanceCriteria: [
      'allocate(money(100, "EUR"), [1, 1, 1]) returns 34, 33 and 33 cents',
      "For any total (including negative totals) and valid ratios, the shares sum to exactly the total",
      "A regression test fails before the fix and passes after it",
      "Results for evenly divisible totals are unchanged",
    ],
    outOfScope: [
      "Switching to a largest-remainder distribution strategy",
      "Changes to any module other than allocate",
    ],
    riskDeclarations: [],
    scopePaths: ["src/allocate.ts", "test/allocate.test.ts"],
  },
  "additive-api": {
    title: "Add multiply() for scaling money by a factor",
    intent:
      "Callers keep re-implementing tax and discount maths with ad-hoc rounding. Add multiply(value, factor) that scales an amount and rounds to the nearest minor unit, halves away from zero, without touching existing functions.",
    acceptanceCriteria: [
      'multiply(money(5, "EUR"), 0.5) is 3 cents and multiply(money(-5, "EUR"), 0.5) is -3 cents',
      "multiply never returns negative zero",
      "Non-finite factors throw a RangeError",
      "multiply is exported from the package entry point and listed in the README",
    ],
    outOfScope: [
      "Changing add, subtract or any other existing export",
      "Banker's rounding or configurable rounding modes",
    ],
    riskDeclarations: [
      {
        area: "public API",
        description: "Adds one new export (multiply); existing signatures are unchanged.",
      },
    ],
    scopePaths: ["src/money.ts", "src/index.ts", "test/money.test.ts", "README.md"],
  },
  "breaking-api": {
    title: "Let formatMoney() render currency symbols",
    intent:
      'Product wants amounts like €1234.56 in receipts. Give formatMoney an options parameter with a required style ("code" keeps today\'s parseable output, "symbol" puts the currency symbol in front) and update every caller in this repository.',
    acceptanceCriteria: [
      'formatMoney(value, { style: "code" }) returns exactly what formatMoney(value) returned before',
      'formatMoney(value, { style: "symbol" }) returns e.g. €1234.56, $0.05, ¥980 and -£12.30',
      "parseMoney still parses the code style",
      "README examples use the new signature",
    ],
    outOfScope: ["Locale-aware formatting via Intl", "Parsing the symbol style"],
    riskDeclarations: [
      {
        area: "public API",
        description:
          "Breaking: formatMoney gains a required options parameter. Downstream callers must be updated; needs a major version bump on release.",
      },
    ],
    scopePaths: ["src/format.ts", "src/index.ts", "test/format.test.ts", "README.md"],
  },
  "new-dependency": {
    title: "Add nanoid as a runtime dependency",
    intent:
      "Transfers need short, URL-safe idempotency keys. Add nanoid as a runtime dependency now; a follow-up change will use it to generate the keys.",
    acceptanceCriteria: [
      "nanoid ^5 is listed under dependencies in package.json",
      "No source or test files change",
    ],
    outOfScope: ["Generating idempotency keys (follow-up change)"],
    riskDeclarations: [
      {
        area: "supply chain",
        description:
          "New third-party runtime dependency (nanoid, no install scripts, no transitive dependencies).",
      },
    ],
    scopePaths: ["package.json", "pnpm-lock.yaml"],
  },
  "touches-auth": {
    title: "Reject session tokens at their exact expiry second",
    intent:
      "verifyToken accepts a token during the very second named by its exp claim. RFC 7519 says a token must not be accepted on or after its expiry time. Tighten the comparison and add a boundary test.",
    acceptanceCriteria: [
      "verifyToken returns null when now equals exp",
      "verifyToken still accepts the token at exp - 1",
      "Signature checks and the token format are unchanged",
    ],
    outOfScope: ["Clock-skew leeway", "Changing the token format or signing algorithm"],
    riskDeclarations: [
      {
        area: "auth",
        description:
          "Tokens expire one second earlier than before; clients that refresh exactly at exp will see one more rejection.",
      },
    ],
    scopePaths: ["src/auth/token.ts", "test/auth.test.ts"],
  },
  "codemod-rename": {
    title: "Rename requireCurrency to toCurrencyCode",
    intent:
      "requireCurrency reads like a guard but actually narrows and returns a CurrencyCode. Rename it to toCurrencyCode everywhere by running the already-reviewed rename-helper codemod, with no hand edits.",
    acceptanceCriteria: [
      "Head equals the output of node .platform/transforms/rename-helper.mjs run on base, byte for byte",
      "No occurrences of requireCurrency remain",
      "The public API (dist/index.d.ts) is unchanged",
    ],
    outOfScope: ["Any hand-written edits", "Renaming exported functions"],
    riskDeclarations: [],
    scopePaths: ["src/**"],
  },
  "policy-change": {
    title: "Lower the Lane 0 changed-line coverage threshold to 50%",
    intent:
      "Legacy formatting code has thin coverage, which keeps small, safe fixes out of Lane 0. Lower thresholds.changedLineCoverage from 0.8 to 0.5 while tests are backfilled.",
    acceptanceCriteria: [
      "thresholds.changedLineCoverage is 0.5 in .platform/policy.ts",
      "No other policy value changes",
    ],
    outOfScope: ["Enabling Lane 0", "Changing the mutation score threshold"],
    riskDeclarations: [
      {
        area: "review policy",
        description: "Weakens the Lane 0 coverage gate for every future change in this repository.",
      },
    ],
    scopePaths: [".platform/policy.ts"],
  },
  "scope-drift": {
    title: "parseMoney: accept comma-grouped thousands",
    intent:
      "Amounts pasted from spreadsheets look like 1,234.56 EUR and parseMoney rejects them. Accept comma-grouped thousands in the whole part while still rejecting malformed grouping.",
    acceptanceCriteria: [
      'parseMoney("1,234.56 EUR") returns 123456 cents',
      "Malformed grouping such as 1,23.00 EUR is still rejected",
      "formatMoney output is unchanged",
    ],
    outOfScope: ["Other modules", "Locale-specific separators (e.g. 1.234,56)"],
    riskDeclarations: [],
    scopePaths: ["src/format.ts", "test/format.test.ts"],
  },
} satisfies Record<string, FixturePlan>;

export type FixturePlanName = keyof typeof FIXTURE_PLANS;
