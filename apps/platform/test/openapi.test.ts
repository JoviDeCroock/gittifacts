import { describe, expect, it } from "vitest";
import { call, makeApp } from "./http.js";

const EXPECTED: Record<string, string[]> = {
  "/api/v1/me": ["get"],
  "/api/v1/capabilities": ["get"],
  "/api/v1/principals": ["get"],
  "/api/v1/principals/{id}": ["get"],
  "/api/v1/principals/agents": ["post"],
  "/api/v1/principals/{id}/tokens": ["delete"],
  "/api/v1/repos": ["get", "post"],
  "/api/v1/repos/{repoId}": ["get"],
  "/api/v1/repos/{repoId}/lane0": ["patch"],
  "/api/v1/repos/{repoId}/plans": ["get"],
  "/api/v1/repos/{repoId}/changes": ["get"],
  "/api/v1/plans": ["post"],
  "/api/v1/plans/{planId}": ["get"],
  "/api/v1/plans/{planId}/approve": ["post"],
  "/api/v1/plans/{planId}/reject": ["post"],
  "/api/v1/changes": ["post"],
  "/api/v1/changes/{changeId}": ["get"],
  "/api/v1/changes/{changeId}/token": ["post"],
  "/api/v1/changes/{changeId}/diff": ["get"],
  "/api/v1/changes/{changeId}/evidence": ["get"],
  "/api/v1/changes/{changeId}/tour": ["get"],
  "/api/v1/changes/{changeId}/review": ["post"],
  "/api/v1/changes/{changeId}/request-review": ["post"],
  "/api/v1/changes/{changeId}/rollout": ["get"],
  "/api/v1/changes/{changeId}/kill": ["post"],
  "/api/v1/changes/{changeId}/issues": ["get"],
  "/api/v1/changes/{changeId}/reviews": ["get"],
  "/api/v1/blobs/{ref}": ["get"],
  "/api/v1/audit": ["get"],
  "/.well-known/gittifacts-keys.json": ["get"],
  "/webhooks/workers-issues": ["post"],
  "/mcp": ["post"],
};

describe("GET /api/v1/openapi.json", () => {
  it("is a valid OpenAPI 3.1 document with every path of the contract", async () => {
    const { app } = makeApp();
    const res = await call(app, "GET", "/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = JSON.parse(await res.text()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    for (const [path, methods] of Object.entries(EXPECTED)) {
      expect(Object.keys(doc.paths), path).toContain(path);
      for (const m of methods) expect(doc.paths[path], `${m} ${path}`).toHaveProperty(m);
    }
    for (const name of [
      "Error",
      "Plan",
      "Change",
      "Repo",
      "Principal",
      "Tour",
      "Evidence",
      "AuditEvent",
    ]) {
      expect(doc.components.schemas, name).toHaveProperty(name);
    }
    expect(doc.components.securitySchemes).toHaveProperty("Bearer");
    // Every mutating route documents Idempotency-Key.
    const approve = doc.paths["/api/v1/plans/{planId}/approve"]!.post as {
      parameters: { name: string; in: string }[];
    };
    expect(approve.parameters).toContainEqual(
      expect.objectContaining({ name: "idempotency-key", in: "header" }),
    );
  });
});
