/**
 * /settings/integrations/developer/:integrationId/deliveries[/:deliveryId] — the webhook delivery
 * log. Wide screens show the list and the open delivery side by side; phones show one at a time
 * (the URL holds the open delivery, so back works).
 */
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { useRoute } from "preact-iso";
import { inlineError, newIdempotencyKey } from "../api/client.js";
import { type DeliveryStatus, integrationsApi, type WebhookEvent } from "../api/integrations.js";
import { DeliveryDetailView, DeliveryRow } from "../components/Deliveries.js";
import { Icon } from "../components/Icon.js";
import { Page } from "../components/Shell.js";
import { Button, EmptyState, ErrorState, Loading, Segmented } from "../components/ui.js";
import { ALL_EVENTS, DELIVERY_FILTERS } from "../lib/integrations.js";
import { useResource } from "../state/resource.js";
import "../styles/integrations.css";

type Filter = "all" | DeliveryStatus;

function DetailPane({
  integrationId,
  deliveryId,
  base,
  onRedelivered,
}: {
  integrationId: string;
  deliveryId: string;
  base: string;
  onRedelivered: () => void;
}) {
  const res = useResource(
    () => integrationsApi.delivery(integrationId, deliveryId),
    [integrationId, deliveryId],
  );
  const busy = useSignal(false);
  const result = useSignal<{ ok: boolean; text: string; href?: string } | null>(null);
  const key = useSignal(newIdempotencyKey());
  const st = res.state.value;

  useEffect(() => {
    result.value = null;
    key.value = newIdempotencyKey();
  }, [deliveryId, result, key]);

  async function redeliver() {
    if (busy.value) return;
    busy.value = true;
    result.value = null;
    try {
      const { delivery } = await integrationsApi.redeliver(integrationId, deliveryId, key.value);
      key.value = newIdempotencyKey();
      result.value = {
        ok: true,
        text: "Redelivery queued.",
        href: `${base}/${encodeURIComponent(delivery.id)}`,
      };
      onRedelivered();
    } catch (err) {
      result.value = { ok: false, text: inlineError(err) };
    } finally {
      busy.value = false;
    }
  }

  if (st.status === "loading") return <Loading label="Loading the delivery" lines={10} />;
  if (st.status === "error")
    return <ErrorState error={st.error} what="this delivery" onRetry={res.reload} />;
  const d = st.data.delivery;
  return (
    <DeliveryDetailView
      d={d}
      originalHref={d.redeliveryOf ? `${base}/${encodeURIComponent(d.redeliveryOf)}` : null}
      actions={
        <>
          {result.value ? (
            <p class={result.value.ok ? "dlv-result" : "field__error"} role="status">
              {result.value.text}{" "}
              {result.value.href ? <a href={result.value.href}>Open it</a> : null}
            </p>
          ) : null}
          <Button
            variant="primary"
            icon="redo"
            busy={busy.value}
            busyLabel="Queuing…"
            onClick={redeliver}
          >
            Redeliver
          </Button>
          <span class="dlv-detail__note">
            Sends the same payload again with the same X-Gittifacts-Delivery ID.
          </span>
        </>
      }
    />
  );
}

export function IntegrationDeliveries() {
  const { params } = useRoute();
  const integrationId = params.integrationId ?? "";
  const deliveryId = params.deliveryId ?? null;
  const filter = useSignal<Filter>("all");
  const event = useSignal<WebhookEvent | "">("");
  const integration = useResource(() => integrationsApi.get(integrationId), [integrationId]);
  const list = useResource(
    () =>
      integrationsApi.deliveries(integrationId, {
        status: filter.value === "all" ? undefined : filter.value,
        event: event.value || undefined,
        limit: 100,
      }),
    [integrationId, filter.value, event.value],
  );
  const it =
    integration.state.value.status === "ok" ? integration.state.value.data.integration : null;
  const st = list.state.value;
  const detailHref = `/settings/integrations/developer/${encodeURIComponent(integrationId)}`;
  const base = `${detailHref}/deliveries`;
  const pending = st.status === "ok" && st.data.deliveries.some((d) => d.status === "pending");

  // Pending deliveries settle on their own; refresh while any are in flight.
  const reload = useRef(list.reload);
  reload.current = list.reload;
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => reload.current(), 5000);
    return () => window.clearInterval(t);
  }, [pending]);

  const crumbs = [
    { href: "/settings/integrations", label: "Integrations" },
    { href: "/settings/integrations/developer", label: "Developer portal" },
    { href: detailHref, label: it?.name ?? "Integration" },
    ...(deliveryId ? [{ href: base, label: "Delivery log" }] : []),
  ];

  return (
    <Page
      title="Delivery log"
      wide
      crumbs={crumbs}
      class={deliveryId ? "dlv-page dlv-page--detail" : "dlv-page"}
      meta={
        it ? (
          <span>
            Webhook deliveries to <code class="inline-code">{it.webhook.url ?? "no URL set"}</code>
            {it.webhook.url && !it.webhook.active ? " (paused)" : ""}. Failed deliveries are retried
            with backoff; redeliver any of them.
          </span>
        ) : null
      }
    >
      <div class="dlv-layout">
        <section class="dlv-list" aria-label="Deliveries">
          <div class="dlv-filters">
            <Segmented
              label="Filter by status"
              size="sm"
              value={filter.value}
              options={DELIVERY_FILTERS.map((f) => ({ id: f.id, label: f.label }))}
              onChange={(v) => (filter.value = v)}
            />
            <label class="dlv-filters__event">
              <span class="sr-only">Filter by event</span>
              <select
                class="input dlv-select"
                value={event.value}
                onChange={(e) => (event.value = e.currentTarget.value as WebhookEvent | "")}
              >
                <option value="">All events</option>
                {[...ALL_EVENTS, "ping" as const].map((ev) => (
                  <option key={ev} value={ev}>
                    {ev}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {st.status === "loading" ? <Loading label="Loading deliveries" lines={8} /> : null}
          {st.status === "error" ? (
            <ErrorState error={st.error} what="the delivery log" onRetry={list.reload} />
          ) : null}
          {st.status === "ok" && st.data.deliveries.length === 0 ? (
            filter.value !== "all" || event.value ? (
              <EmptyState
                icon="search"
                title="No deliveries match"
                action={
                  <Button
                    size="sm"
                    onClick={() => {
                      filter.value = "all";
                      event.value = "";
                    }}
                  >
                    Clear filters
                  </Button>
                }
              >
                <p>
                  Nothing {filter.value !== "all" ? filter.value : "sent"}
                  {event.value ? ` for ${event.value}` : ""} in the recent log.
                </p>
              </EmptyState>
            ) : (
              <EmptyState icon="webhook" title="No deliveries yet">
                <p>
                  Deliveries appear when someone installs the integration and pushes. Send a ping
                  from the integration's settings to test your endpoint.
                </p>
              </EmptyState>
            )
          ) : null}
          {st.status === "ok" && st.data.deliveries.length > 0 ? (
            <ul class="dlvs">
              {st.data.deliveries.map((d) => (
                <DeliveryRow
                  key={d.id}
                  d={d}
                  href={`${base}/${encodeURIComponent(d.id)}`}
                  current={d.id === deliveryId}
                />
              ))}
            </ul>
          ) : null}
        </section>
        <section class="dlv-pane" aria-label="Delivery">
          {deliveryId ? (
            <DetailPane
              integrationId={integrationId}
              deliveryId={deliveryId}
              base={base}
              onRedelivered={list.reload}
            />
          ) : (
            <p class="dlv-pane__empty">
              <Icon name="webhook" size={20} />
              Pick a delivery to see its headers, payload and response.
            </p>
          )}
        </section>
      </div>
    </Page>
  );
}
