/**
 * Delegated agent auth (onboarding O4): OAuth authorization-code + PKCE and RFC 8628 device flow.
 *
 * Every approved grant becomes its own agent Principal (owned by the approving human) plus one
 * `agent_sessions` row. Access tokens are ordinary `agent_tokens` rows (`gtf_…`, audience-bound);
 * refresh tokens (`gtr_…`) live here and rotate on every use. Scopes and repos live on the
 * principal (single source of truth), never on the session.
 *
 * The better-auth `deviceCode` table (device-authorization plugin) is in ./auth-schema.ts.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { principals } from "./app-schema.js";

export const OAUTH_FLOWS = ["authorization_code", "device_code"] as const;
export type OAuthFlow = (typeof OAUTH_FLOWS)[number];

/** One delegated agent session: a client a human approved, bound to a fresh agent principal. */
export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    /** The human principal who approved it and is accountable for it. */
    ownerId: text("owner_id")
      .notNull()
      .references(() => principals.id),
    flow: text("flow", { enum: OAUTH_FLOWS }).notNull(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    clientUri: text("client_uri"),
    /** Resource URIs the session's tokens are bound to (RFC 8707). */
    audience: text("audience", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: text("created_at").notNull(),
    /** Hard end of the session (the human's expiry choice); no token outlives it. */
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    revokedBy: text("revoked_by"),
  },
  (t) => [
    uniqueIndex("agent_sessions_principal_uq").on(t.principalId),
    index("agent_sessions_owner_idx").on(t.ownerId, t.createdAt),
  ],
);

/**
 * One authorization attempt. Code flow: created by `/api/oauth/authorize` (pending), decided on the
 * consent screen (approved → one-time code), redeemed at the token endpoint. Device flow: created
 * when the human approves a user code (the device code itself is better-auth's `deviceCode` row).
 */
export const oauthRequests = sqliteTable(
  "oauth_requests",
  {
    /** Unguessable (32 random bytes, base64url): it is the consent screen's URL. */
    id: text("id").primaryKey(),
    flow: text("flow", { enum: OAUTH_FLOWS }).notNull(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    clientUri: text("client_uri"),
    /** first-party | cimd: how the client was identified. */
    clientKind: text("client_kind", { enum: ["first-party", "cimd"] }).notNull(),
    redirectUri: text("redirect_uri"),
    state: text("state"),
    /** PKCE S256 challenge (code flow only; required). */
    codeChallenge: text("code_challenge"),
    /** better-auth deviceCode.id (device flow only). */
    deviceCodeId: text("device_code_id"),
    audience: text("audience", { mode: "json" }).$type<string[]>().notNull(),
    requestedScopes: text("requested_scopes", { mode: "json" }).$type<string[]>().notNull(),
    status: text("status", { enum: ["pending", "approved", "denied", "redeemed"] }).notNull(),
    /** The human principal deciding; bound on first view of the consent screen. */
    ownerId: text("owner_id").references(() => principals.id),
    grantedScopes: text("granted_scopes", { mode: "json" }).$type<string[]>(),
    /** NULL with status approved = all repos (an explicit choice). */
    grantedRepoIds: text("granted_repo_ids", { mode: "json" }).$type<string[] | null>(),
    sessionDays: integer("session_days"),
    agentName: text("agent_name"),
    /** hex SHA-256 of the one-time authorization code. */
    codeHash: text("code_hash"),
    codeExpiresAt: text("code_expires_at"),
    /** agent_sessions.id once redeemed (code reuse revokes it). */
    sessionId: text("session_id"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (t) => [
    uniqueIndex("oauth_requests_code_hash_uq").on(t.codeHash),
    uniqueIndex("oauth_requests_device_code_uq").on(t.deviceCodeId),
    index("oauth_requests_expires_idx").on(t.expiresAt),
  ],
);

/** Rotating refresh tokens (`gtr_…`), stored as SHA-256 only. Reuse of a rotated one revokes the session. */
export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    rotatedAt: text("rotated_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    uniqueIndex("oauth_refresh_tokens_hash_uq").on(t.tokenHash),
    index("oauth_refresh_tokens_session_idx").on(t.sessionId),
  ],
);
