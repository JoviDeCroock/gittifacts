import { describe, expect, it } from "vitest";
import {
  APP_HOME,
  githubCallbackUrl,
  isServerPath,
  postAuthTarget,
  SPA_SCOPE,
  safeNext,
  signInHref,
} from "../src/lib/nav.js";

describe("where sign-in lands", () => {
  it("lands on the dashboard without a next", () => {
    expect(APP_HOME).toBe("/dashboard");
    expect(postAuthTarget(undefined)).toBe("/dashboard");
    expect(postAuthTarget(null)).toBe("/dashboard");
    expect(postAuthTarget("")).toBe("/dashboard");
  });

  it("keeps a same-origin next, deep links and queries unchanged", () => {
    for (const next of [
      "/changes/ch_1",
      "/changes/ch_1/evidence",
      "/repos/r_1/queue",
      "/settings/github?installation_id=7&setup_action=install",
      "/claim/tok_abc",
      "/device?user_code=ABCD-EFGH",
      "/oauth/consent?request=req_1",
      "/github/callback?code=x&state=y",
    ]) {
      expect(postAuthTarget(next), next).toBe(next);
    }
  });

  it("refuses other origins, sign-in loops and the marketing page", () => {
    for (const bad of [
      "https://evil.example/x",
      "//evil.example/x",
      "/\\evil.example",
      "javascript:alert(1)",
      "dashboard",
      "/signin",
      "/signin?next=/signin",
      "/",
      "/?mock",
      "/\u0000x",
    ]) {
      expect(safeNext(bad), bad).toBeNull();
      expect(postAuthTarget(bad), bad).toBe("/dashboard");
    }
  });
});

describe("sending a visitor to sign in", () => {
  it("names where to come back to, except for the dashboard itself", () => {
    expect(signInHref("/changes/ch_1")).toBe("/signin?next=%2Fchanges%2Fch_1");
    expect(signInHref("/settings/github?x=1")).toBe("/signin?next=%2Fsettings%2Fgithub%3Fx%3D1");
    expect(signInHref("/dashboard")).toBe("/signin");
    expect(signInHref("/")).toBe("/signin");
    expect(signInHref("/signin")).toBe("/signin");
  });
});

describe("GitHub sign-in's callback", () => {
  it("from /signin: next, else the dashboard (never /signin itself)", () => {
    expect(githubCallbackUrl("/signin", "")).toBe("/dashboard");
    expect(githubCallbackUrl("/signin", "?mode=signup")).toBe("/dashboard");
    expect(githubCallbackUrl("/signin", "?next=%2Fclaim%2Ftok")).toBe("/claim/tok");
    expect(githubCallbackUrl("/signin", "?next=https%3A%2F%2Fevil.example")).toBe("/dashboard");
  });

  it("from a screen showing sign-in in place: that screen", () => {
    expect(githubCallbackUrl("/claim/tok", "")).toBe("/claim/tok");
    expect(githubCallbackUrl("/", "")).toBe("/dashboard");
  });
});

describe("server paths need a full navigation", () => {
  it("knows the Worker's pages from SPA routes", () => {
    for (const p of [
      "/",
      "/github/setup?x=1",
      "/docs",
      "/docs/quickstart",
      "/start",
      "/start.md",
      "/llms.txt",
      "/oauth/authorize?client_id=x",
      "/api/v1/me",
    ]) {
      expect(isServerPath(p), p).toBe(true);
    }
    for (const p of [
      "/dashboard",
      "/changes/ch_1",
      "/settings/github",
      "/oauth/consent?request=r",
      "/device",
      "/claim/t",
      "/startup",
      "/docsy",
    ]) {
      expect(isServerPath(p), p).toBe(false);
    }
  });
});

describe("the router's scope", () => {
  it("handles app links in the page and leaves server paths to a full navigation", () => {
    for (const href of [
      "/dashboard",
      "/repos/r1?filter=all",
      "/changes/c1/evidence",
      "/agents",
      "?filter=all",
      "/settings/github",
    ])
      expect(SPA_SCOPE.test(href), href).toBe(true);
    for (const href of [
      "/",
      "/docs",
      "/docs/concepts/plans",
      "/docs/concepts/lanes#calibrating",
      "/start",
      "/api/v1/me",
      "/cli/v2/gittifacts.tgz",
    ])
      expect(SPA_SCOPE.test(href), href).toBe(false);
  });
});
