/**
 * `CiEgressGateway`: the Worker side of `network: "registries-only"`. The Runner points the
 * container's HTTP/HTTPS interception at `ctx.exports.CiEgressGateway({ props })`; allowed
 * requests are forwarded with `fetch`, everything else gets a 403 and a line in the step log.
 * The platform Worker must export this class from its entry module.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { describeUrl, type EgressDenial, EgressProps, egressDecision } from "./egress.js";

export interface EgressGatewayEnv {
  RUNNER?: {
    getByName(name: string): { noteEgressDenied(denial: EgressDenial): Promise<unknown> };
  };
}

export class CiEgressGateway extends WorkerEntrypoint<EgressGatewayEnv, unknown> {
  override async fetch(request: Request): Promise<Response> {
    const props = EgressProps.safeParse(this.ctx.props);
    if (!props.success) {
      return new Response("gittifacts: egress gateway misconfigured (invalid props)\n", {
        status: 500,
      });
    }
    const decision = egressDecision(request.method, request.url, props.data);
    if (decision.allowed) return fetch(request);
    const denial: EgressDenial = {
      method: request.method.slice(0, 16),
      url: describeUrl(request.url),
      reason: decision.reason.slice(0, 300),
    };
    try {
      await this.env.RUNNER?.getByName(props.data.runner).noteEgressDenied(denial);
    } catch {
      // Reporting is best effort; the request is refused either way.
    }
    return new Response(
      `gittifacts: outbound ${denial.method} ${denial.url} blocked (${denial.reason}). ` +
        `This project's CI may only reach package registries (${props.data.registries.join(", ")}).\n`,
      { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
}
