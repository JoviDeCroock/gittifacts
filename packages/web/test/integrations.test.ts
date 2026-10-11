import { describe, expect, it } from "vitest";
import {
  deliveryStatus,
  lines,
  prettyJson,
  redirectUrisProblem,
  repoLine,
  scopeText,
  sortScopes,
  urlProblem,
} from "../src/lib/integrations.js";

describe("integration copy", () => {
  it("names repositories in plain words", () => {
    expect(repoLine("all", [])).toBe("All repositories");
    expect(repoLine("selected", [])).toBe("No repositories");
    expect(repoLine("selected", [{ name: "api" }])).toBe("api");
    expect(repoLine("selected", [{ name: "api" }, { name: "web" }])).toBe("api and web");
    expect(repoLine("selected", [{ name: "a" }, { name: "b" }, { name: "c" }])).toBe("a, b and c");
    expect(repoLine("selected", [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }])).toBe(
      "a, b and 2 more",
    );
  });

  it("explains scopes with the server's words, in catalog order", () => {
    expect(scopeText("contents:read").title).toBe("Clone the code");
    expect(sortScopes(["checks:write", "repo:read", "webhooks"])).toEqual([
      "repo:read",
      "webhooks",
      "checks:write",
    ]);
  });

  it("never shows a retrying delivery as plain pending", () => {
    expect(deliveryStatus({ status: "pending", attempts: 0 }).label).toBe("Pending");
    expect(deliveryStatus({ status: "pending", attempts: 2 })).toMatchObject({
      label: "Retrying",
      tone: "warn",
    });
    expect(deliveryStatus({ status: "failed", attempts: 8 }).tone).toBe("danger");
  });
});

describe("integration form checks", () => {
  it("splits redirect URIs one per line, trimmed and deduplicated", () => {
    expect(
      lines(" https://a.example/cb \n\nhttps://a.example/cb\r\nhttp://localhost:3000/cb"),
    ).toEqual(["https://a.example/cb", "http://localhost:3000/cb"]);
  });

  it("allows https anywhere and http only on localhost", () => {
    expect(urlProblem("https://deploy.example/cb", "It")).toBeNull();
    expect(urlProblem("http://localhost:8788/cb", "It")).toBeNull();
    expect(urlProblem("http://deploy.example/cb", "It")).toMatch(/https/);
    expect(urlProblem("deploy.example", "It")).toMatch(/full URL/);
  });

  it("refuses an empty list and fragments", () => {
    expect(redirectUrisProblem([])).toMatch(/at least one/);
    expect(redirectUrisProblem(["https://a.example/cb#x"])).toMatch(/fragment/);
    expect(redirectUrisProblem(["https://a.example/cb"])).toBeNull();
  });

  it("pretty-prints JSON bodies and leaves anything else alone", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("<html>")).toBe("<html>");
  });
});
