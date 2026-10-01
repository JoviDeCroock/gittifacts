import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { type ApiApp, json } from "./common.js";

export const KEYS_PATH = "/.well-known/gittifacts-keys.json";

const PublishedKeySchema = z
  .object({
    keyId: z.string(),
    alg: z.literal("Ed25519"),
    publicKey: z.string().describe("base64url raw 32-byte Ed25519 public key"),
    notAfter: z
      .string()
      .optional()
      .describe("Signatures made after this instant are not valid under this key"),
  })
  .meta({ id: "PublishedKey" });

const keys = createRoute({
  method: "get",
  path: KEYS_PATH,
  tags: ["keys"],
  summary: "Platform signing keys (evidence, plan approvals, audit entries)",
  description: "Accepted by `verify-attestation --keys`. Public; cacheable.",
  responses: { 200: json(z.object({ keys: z.array(PublishedKeySchema) }), "Key set") },
});

export function registerWellKnownRoutes(app: ApiApp): void {
  app.openapi(keys, async (c) => {
    const signer = await c.get("services").signer();
    c.header("cache-control", "public, max-age=300");
    return c.json(signer.publishedKeys(), 200);
  });
}
