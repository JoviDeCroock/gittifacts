/**
 * `login` (OAuth device flow), `logout`. Logging in is optional: unclaimed projects work without
 * an account, and GITTIFACTS_TOKEN overrides whatever is stored.
 */
import {
  discoverEndpoints,
  pollForToken,
  requestDeviceCode,
  type TokenResponse,
} from "../auth/device-flow.js";
import { noHostError, normalizeHost, resolveHost, updateCredentials } from "../config.js";
import type { Ctx } from "../context.js";
import { cliError, EXIT } from "../errors.js";
import { isAbort } from "../failures.js";
import { type Builtin, bool, builtinSpec, int, str } from "./builtin.js";

function hostFor(ctx: Ctx): string {
  const resolved = resolveHost(ctx.globals.host, ctx.io.env, ctx.project()?.config ?? null, ctx.creds());
  if (!resolved) throw noHostError();
  return resolved.host;
}

const loginSpec = builtinSpec({
  command: "login",
  title: "Log in",
  description:
    "Log in with the OAuth device flow (RFC 8628): open the printed URL, confirm the code, and the token is stored in ~/.config/gittifacts/credentials.json (0600) for this host. Optional: unclaimed projects work without it.",
  properties: {
    scope: { type: "string", description: "Space-separated scopes to request (default: the platform's)." },
    noWait: { type: "boolean", description: "Print the code and URL as JSON and exit; finish later with --device-code." },
    deviceCode: { type: "string", description: "Finish a login started with --no-wait." },
    interval: { type: "integer", description: "Polling interval in seconds with --device-code (default 5)." },
    expiresIn: { type: "integer", description: "Seconds left on the --device-code (default 1800)." },
    clientId: { type: "string", description: "OAuth client id (default gittifacts-cli, or what /start names)." },
    deviceCodeUrl: { type: "string", description: "Device authorization endpoint (default: discovered)." },
    tokenUrl: { type: "string", description: "Token endpoint (default: discovered)." },
  },
});

export const login: Builtin = {
  spec: loginSpec,
  examples: [
    "gittifacts login --host https://gittifacts.example",
    "gittifacts login --no-wait   # agent: hand the URL to a human, then:",
    "gittifacts login --device-code <deviceCode>",
  ],
  async run(ctx, parsed) {
    const host = hostFor(ctx);
    const env = ctx.io.env;
    const endpoints = await discoverEndpoints(ctx.io.fetch, host, {
      deviceCodeUrl: str(parsed, "deviceCodeUrl") ?? env.GITTIFACTS_DEVICE_CODE_URL,
      tokenUrl: str(parsed, "tokenUrl") ?? env.GITTIFACTS_DEVICE_TOKEN_URL,
      clientId: str(parsed, "clientId") ?? env.GITTIFACTS_CLIENT_ID,
    });

    let deviceCode = str(parsed, "deviceCode");
    let interval = int(parsed, "interval") ?? 5;
    let expiresIn = int(parsed, "expiresIn") ?? 1800;
    if (deviceCode === undefined) {
      const auth = await requestDeviceCode(ctx.io.fetch, host, endpoints, str(parsed, "scope"));
      deviceCode = auth.deviceCode;
      interval = auth.interval;
      expiresIn = auth.expiresIn;
      const url = auth.verificationUriComplete ?? auth.verificationUri;
      if (bool(parsed, "noWait")) {
        ctx.out.result(
          {
            host,
            userCode: auth.userCode,
            verificationUri: auth.verificationUri,
            verificationUriComplete: auth.verificationUriComplete,
            deviceCode: auth.deviceCode,
            interval: auth.interval,
            expiresIn: auth.expiresIn,
            expiresAt: new Date(ctx.io.now() + auth.expiresIn * 1000).toISOString(),
            nextSteps: [
              {
                title: `A human opens ${url} and confirms the code ${auth.userCode}`,
                why: "Humans approve what an agent may do; the CLI never sees their password.",
              },
              {
                title: "Finish the login (waits for the approval)",
                command: `gittifacts login --host ${host} --device-code ${auth.deviceCode} --interval ${auth.interval} --expires-in ${auth.expiresIn}`,
              },
            ],
          },
          { title: "Device login started" },
        );
        return EXIT.ok;
      }
      const minutes = Math.max(1, Math.round(auth.expiresIn / 60));
      ctx.out.notice(
        [
          `To log in to ${host}, open:`,
          `  ${url}`,
          `and confirm the code: ${auth.userCode}   (expires in ${minutes} min)`,
          "Waiting for approval... (Ctrl-C to cancel)",
        ].join("\n"),
      );
    }

    const ac = new AbortController();
    const off = ctx.io.onInterrupt(() => ac.abort(new Error("aborted")));
    let token: TokenResponse;
    try {
      token = await pollForToken({
        fetch: ctx.io.fetch,
        host,
        tokenUrl: endpoints.tokenUrl,
        clientId: endpoints.clientId,
        deviceCode,
        intervalSec: interval,
        expiresInSec: expiresIn,
        now: () => ctx.io.now(),
        sleep: (ms, signal) => ctx.io.sleep(ms, signal),
        signal: ac.signal,
        onEvent: (e) => {
          if (e.type === "slow_down") ctx.out.progress(`server asked to slow down: polling every ${e.intervalSec}s`);
          if (e.type === "retry") ctx.out.progress(`token endpoint unavailable (${e.reason}); retrying in ${e.intervalSec}s`);
        },
      });
    } catch (e) {
      if (ac.signal.aborted || isAbort(e)) {
        throw cliError("interrupted", "login cancelled", {
          explanation: "Nothing was stored. Finish the same login later (if the code hasn't expired) or start over.",
          command: `gittifacts login --host ${host} --device-code ${deviceCode}`,
        }, { exitCode: EXIT.interrupted });
      }
      throw e;
    } finally {
      off();
    }

    const now = ctx.io.now();
    const expiresAt = token.expiresIn !== null ? new Date(now + token.expiresIn * 1000).toISOString() : null;
    updateCredentials(ctx.credentialsPath, (c) => {
      const h = (c.hosts[host] ??= {});
      h.login = {
        token: token.accessToken,
        tokenType: token.tokenType,
        scope: token.scope,
        expiresAt,
        obtainedAt: new Date(now).toISOString(),
        via: "device-flow",
      };
      c.defaultHost = host;
    });
    ctx.invalidate();
    ctx.out.result(
      {
        loggedIn: true,
        host,
        tokenType: token.tokenType,
        scope: token.scope,
        expiresAt,
        credentialsPath: ctx.credentialsPath,
        ...(env.GITTIFACTS_TOKEN ? { note: "GITTIFACTS_TOKEN is set and still takes precedence over this login." } : {}),
        nextSteps: [{ title: "Check who you are and what you may do", command: "gittifacts whoami" }],
      },
      { title: "Logged in" },
    );
    return EXIT.ok;
  },
};

export const logout: Builtin = {
  spec: builtinSpec({
    command: "logout",
    title: "Log out",
    description:
      "Forget this host's login token. --all also forgets the tokens of unclaimed projects created from this machine.",
    properties: { all: { type: "boolean", description: "Also remove project tokens for this host." } },
  }),
  async run(ctx, parsed) {
    const host = normalizeHost(hostFor(ctx));
    const all = bool(parsed, "all");
    let removedLogin = false;
    let removedProjects = 0;
    updateCredentials(ctx.credentialsPath, (c) => {
      const h = c.hosts[host];
      if (!h) return;
      removedLogin = h.login !== undefined;
      delete h.login;
      if (all) {
        removedProjects = Object.keys(h.projects ?? {}).length;
        delete c.hosts[host];
      } else if (!h.projects || Object.keys(h.projects).length === 0) {
        delete c.hosts[host];
      }
      if (c.defaultHost === host) delete c.defaultHost;
    });
    ctx.invalidate();
    ctx.out.result(
      {
        loggedOut: removedLogin || removedProjects > 0,
        host,
        removed: { login: removedLogin, projectTokens: removedProjects },
        credentialsPath: ctx.credentialsPath,
        ...(ctx.io.env.GITTIFACTS_TOKEN ? { note: "GITTIFACTS_TOKEN is still set in your environment." } : {}),
      },
      { title: "Logged out" },
    );
    return EXIT.ok;
  },
};
