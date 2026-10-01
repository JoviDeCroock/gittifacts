import { formatCents } from "@queue/money";

export function priceLabel(cents: number): string {
  return `Price: ${formatCents(cents)}`;
}

export function priceResponse(cents: number): Response {
  return new Response(priceLabel(cents), { headers: { "content-type": "text/plain" } });
}
