/**
 * Webhook delivery rows and the delivery detail (request headers with the signature, the raw
 * payload pretty-printed in a box that scrolls inside itself, the response, and Redeliver).
 */
import type { ComponentChildren } from "preact";
import type { DeliveryDetail, DeliverySummary } from "../api/integrations.js";
import { deliveryStatus, prettyJson } from "../lib/integrations.js";
import { durationLabel, formatDateTime, relative, shortAge } from "../lib/time.js";
import { minuteClock } from "../state/clock.js";
import { Icon } from "./Icon.js";
import { CopyButton, StatusChip } from "./ui.js";

const REASON: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  410: "Gone",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export function responseLabel(status: number | null): string {
  if (status === null) return "No response";
  return REASON[status] ? `${status} ${REASON[status]}` : String(status);
}

export function DeliveryRow({
  d,
  href,
  current,
}: {
  d: DeliverySummary;
  href: string;
  current?: boolean;
}) {
  const now = minuteClock.value;
  const parts = [
    // A cancelled delivery will never be sent: "yet" would promise a send that never comes.
    d.responseStatus === null
      ? d.attempts === 0
        ? d.status === "cancelled"
          ? "Not sent"
          : "Not sent yet"
        : "No response"
      : String(d.responseStatus),
  ];
  if (d.durationMs !== null) parts.push(durationLabel(d.durationMs));
  if (d.attempts > 1) parts.push(`${d.attempts} attempts`);
  if (d.redeliveryOf) parts.push("Redelivery");
  return (
    <li class="dlv">
      <a href={href} class="dlv__link" aria-current={current ? "true" : undefined}>
        <span class="dlv__event">
          <code>{d.event}</code>
          {d.action ? <span class="dlv__action"> {d.action}</span> : null}
          {d.repo ? <span class="dlv__repo"> · {d.repo.name}</span> : null}
        </span>
        <time class="dlv__time tnum" dateTime={d.createdAt} title={formatDateTime(d.createdAt)}>
          {shortAge(d.createdAt, now)}
        </time>
        <span class="dlv__state">
          <StatusChip meta={deliveryStatus(d)} />
          <span class="dlv__meta tnum">{parts.join(" · ")}</span>
        </span>
      </a>
    </li>
  );
}

function Block({ title, aside, children }: { title: string; aside?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="dlv-block">
      <div class="dlv-block__head">
        <h3 class="dlv-block__title">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function DeliveryDetailView({
  d,
  originalHref,
  actions,
}: {
  d: DeliveryDetail;
  originalHref: string | null;
  actions: ComponentChildren;
}) {
  const now = minuteClock.value;
  const payload = prettyJson(d.payload);
  // Header names are case-insensitive (the server sends them lower-case).
  const isSignature = (k: string) => k.toLowerCase() === "x-gittifacts-signature-256";
  const signature = Object.entries(d.requestHeaders).find(([k]) => isSignature(k))?.[1];
  return (
    <article class="dlv-detail" aria-labelledby="dlv-title">
      <header class="dlv-detail__head">
        <h2 id="dlv-title" class="dlv-detail__title">
          <code>{d.event}</code>
          {d.repo ? <span> · {d.repo.name}</span> : null}
        </h2>
        <StatusChip meta={deliveryStatus(d)} />
      </header>
      {d.error ? (
        <p class={`dlv-detail__error dlv-detail__error--${d.status}`} role="note">
          <Icon name={d.status === "cancelled" ? "info" : "triangle-alert"} size={16} />
          <span>{d.error}</span>
        </p>
      ) : null}
      <dl class="kv dlv-detail__kv">
        <dt>Response</dt>
        <dd class="tnum">
          {responseLabel(d.responseStatus)}
          {d.durationMs !== null ? ` in ${durationLabel(d.durationMs)}` : ""}
        </dd>
        <dt>Attempts</dt>
        <dd class="tnum">
          {d.attempts}
          {d.nextAttemptAt ? ` · next ${relative(d.nextAttemptAt, now)}` : ""}
        </dd>
        <dt>Created</dt>
        <dd class="tnum">{formatDateTime(d.createdAt)}</dd>
        {d.lastAttemptAt ? (
          <>
            <dt>Last attempt</dt>
            <dd class="tnum">{formatDateTime(d.lastAttemptAt)}</dd>
          </>
        ) : null}
        <dt>Sent to</dt>
        <dd>
          <code class="dlv-detail__url">{d.url}</code>
        </dd>
        <dt>Delivery</dt>
        <dd>
          <code class="dlv-detail__url">{d.guid}</code>
        </dd>
        {d.redeliveryOf ? (
          <>
            <dt>Redelivery of</dt>
            <dd>{originalHref ? <a href={originalHref}>the original delivery</a> : d.redeliveryOf}</dd>
          </>
        ) : null}
      </dl>

      <Block title="Request headers" aside={signature ? <CopyButton text={signature} label="Copy signature" /> : null}>
        <dl class="dlv-headers">
          {Object.entries(d.requestHeaders).map(([k, v]) => (
            <div key={k} class={isSignature(k) ? "is-signature" : undefined}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </Block>

      <Block title="Payload" aside={<CopyButton text={d.payload} label="Copy raw body" />}>
        <pre class="dlv-code" tabIndex={0} aria-label="Payload JSON">
          <code>{payload}</code>
        </pre>
        <p class="field__hint">
          The signature covers the raw body exactly as sent, not this pretty-printed copy.
        </p>
      </Block>

      <Block title="Response">
        {d.responseBody ? (
          <pre class="dlv-code dlv-code--short" tabIndex={0} aria-label="Response body">
            <code>{d.responseBody}</code>
          </pre>
        ) : (
          <p class="ev-sub">{d.responseStatus === null ? "No response was received." : "Empty body."}</p>
        )}
      </Block>

      <div class="dlv-detail__actions">{actions}</div>
    </article>
  );
}
