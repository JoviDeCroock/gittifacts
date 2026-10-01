export interface Item {
  price: number;
  qty: number;
}

function subtotal(item: Item): number {
  return item.price * item.qty;
}

export function cartTotal(items: Item[]): number {
  let total = 0;
  for (const item of items) total += subtotal(item);
  return total;
}
