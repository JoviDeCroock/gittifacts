import { clampCents, formatCents } from "@queue/money";

/** Prices are never negative and never above 1,000,000.00. */
export const MAX_PRICE_CENTS = 100_000_000;

export function priceLabel(cents: number): string {
  return `Price: ${formatCents(clampCents(cents, 0, MAX_PRICE_CENTS))}`;
}

export function priceResponse(cents: number): Response {
  return new Response(priceLabel(cents), { headers: { "content-type": "text/plain" } });
}
