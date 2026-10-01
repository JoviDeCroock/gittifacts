import { formatCents } from "@queue/money";

export interface InvoiceItem {
  description: string;
  cents: number;
}

/** One line per item, then the total: "Coffee: 3.50 EUR". */
export function invoiceLines(items: readonly InvoiceItem[]): string[] {
  const total = items.reduce((sum, item) => sum + item.cents, 0);
  return [
    ...items.map((item) => `${item.description}: ${formatCents(item.cents)}`),
    `Total: ${formatCents(total)}`,
  ];
}
