/**
 * What the reference generators read from the platform Worker (apps/platform). Bundled with
 * esbuild by generate/lib/platform.ts, with `cloudflare:*` modules stubbed, so the route
 * definitions (OpenAPI) and plain constants can be evaluated in Node. Not type-checked by
 * @app/docs (the platform has its own typecheck).
 */
export { createApp } from "../../../apps/platform/src/app.js";
export { DEFAULT_UNCLAIMED_LIMITS } from "../../../apps/platform/src/limits/config.js";
export { DEFAULT_LIMITS as WORKSPACE_LIMITS } from "../../../apps/platform/src/workspace/model.js";
export {
  DEFAULT_EVENTS,
  DEPLOY_PLATFORM_SCOPES,
  INTEGRATION_SCOPES,
  NEVER_WORDS,
  SCOPE_WORDS,
  WebhookEvent,
} from "../../../apps/platform/src/integrations/scopes.js";
export {
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  USER_AGENT,
} from "../../../apps/platform/src/integrations/delivery.js";
export { REFRESH_TOKEN_TTL_DAYS as INTEGRATION_REFRESH_TTL_DAYS } from "../../../apps/platform/src/integrations/tokens.js";
export { ACCESS_TOKEN_TTL_SEC } from "../../../apps/platform/src/oauth/tokens.js";
export {
  CODE_TTL_MS,
  DEFAULT_SESSION_DAYS,
  SESSION_DAY_CHOICES,
} from "../../../apps/platform/src/oauth/consent.js";
export { REQUEST_TTL_MS } from "../../../apps/platform/src/oauth/authorize.js";
export { DEVICE_CODE_TTL, DEVICE_POLL_INTERVAL } from "../../../apps/platform/src/oauth/device.js";
export { OAUTH_PATHS } from "../../../apps/platform/src/oauth/urls.js";
export {
  DEFAULT_SESSION_SCOPES,
  DELEGABLE_SCOPES,
  NEVER_DELEGATED,
} from "../../../apps/platform/src/oauth/scopes.js";
export { CLI_CLIENT_ID } from "../../../apps/platform/src/oauth/clients.js";
export { FRONT_DOOR_PATHS, discoveryDocuments } from "../../../apps/platform/src/routes/front-door.js";
export { OPENAPI_PATH } from "../../../apps/platform/src/app.js";
