import { describe, expect, it } from "vitest";
import {
  audiencePhrase,
  consentCopy,
  formatUserCode,
  neverPhrases,
  repoPhrase,
  sessionLengthPhrase,
} from "../src/lib/consent-copy.js";

describe("consentCopy", () => {
  it("says the default grant in plain words: open Changes on repo X · read repo X", () => {
    const c = consentCopy({
      clientName: "Claude Code",
      scopes: ["repo:read", "change:create"],
      repos: { kind: "some", names: ["acme/api"] },
    });
    expect(c.summary).toBe("Claude Code wants to: open Changes on acme/api · read acme/api");
    expect(c.lead).toBe("Claude Code wants to:");
    expect(c.can).toEqual(["open Changes on acme/api", "read acme/api"]);
  });

  it("orders capabilities by consequence, whatever order the scopes come in", () => {
    const c = consentCopy({
      clientName: "fleet-coder",
      scopes: ["repo:read", "plan:create", "change:create"],
      repos: { kind: "some", names: ["acme/api", "acme/web"] },
    });
    expect(c.can).toEqual([
      "open Changes on acme/api and acme/web",
      "draft Plans for acme/api and acme/web",
      "read acme/api and acme/web",
    ]);
  });

  it("always says what an agent can never do", () => {
    const c = consentCopy({ clientName: "X", scopes: ["repo:read"], repos: { kind: "all" } });
    expect(c.never).toEqual(["approve plans or changes", "change policy", "administer repositories"]);
    expect(c.neverSentence).toBe(
      "It can never approve plans or changes, change policy or administer repositories.",
    );
  });

  it("never lists an approval-class scope as something it can do, even if one sneaks in", () => {
    const c = consentCopy({
      clientName: "Sneaky",
      scopes: ["plan:approve", "change:review", "policy:admin", "repo:admin", "repo:read"],
      repos: { kind: "some", names: ["acme/api"] },
    });
    expect(c.can).toEqual(["read acme/api"]);
    expect(c.summary).not.toMatch(/approve|policy|administer/);
  });

  it("says 'all your repositories' only for the explicit all choice", () => {
    const c = consentCopy({ clientName: "CLI", scopes: ["change:create"], repos: { kind: "all" } });
    expect(c.summary).toBe("CLI wants to: open Changes on all your repositories");
  });

  it("asks the human to pick when nothing is selected", () => {
    const c = consentCopy({ clientName: "CLI", scopes: [], repos: { kind: "some", names: [] } });
    expect(c.can).toEqual([]);
    expect(c.summary).toBe("CLI asks for nothing yet. Pick what it may do.");
  });

  it("falls back to a neutral name for an empty client name", () => {
    expect(
      consentCopy({ clientName: "  ", scopes: ["repo:read"], repos: { kind: "some", names: ["a"] } }).lead,
    ).toBe("This app wants to:");
  });
});

describe("repoPhrase", () => {
  it("lists one, two, or two and a count", () => {
    expect(repoPhrase({ kind: "some", names: ["a"] })).toBe("a");
    expect(repoPhrase({ kind: "some", names: ["a", "b"] })).toBe("a and b");
    expect(repoPhrase({ kind: "some", names: ["a", "b", "c", "d"] })).toBe("a, b and 2 more");
    expect(repoPhrase({ kind: "some", names: ["a", "a", " "] })).toBe("a");
    expect(repoPhrase({ kind: "some", names: [] })).toBe("no repository yet");
  });
});

describe("neverPhrases", () => {
  it("merges plan approval and change review into one phrase", () => {
    expect(neverPhrases(["change:review"])).toEqual(["approve plans or changes"]);
    expect(neverPhrases(["policy:admin"])).toEqual(["change policy"]);
    expect(neverPhrases([])).toEqual([]);
  });
});

describe("small phrases", () => {
  it("session length, audience and user codes", () => {
    expect(sessionLengthPhrase(1)).toBe("for 1 day");
    expect(sessionLengthPhrase(30)).toBe("for 30 days");
    expect(audiencePhrase(["MCP server"])).toBe("through the MCP server");
    expect(audiencePhrase(["MCP server", "HTTP API"])).toBe("through the MCP server and the HTTP API");
    expect(formatUserCode("abcd2345")).toBe("ABCD-2345");
    expect(formatUserCode("ab cd-23 45")).toBe("ABCD-2345");
    expect(formatUserCode("abc")).toBe("ABC");
  });
});
