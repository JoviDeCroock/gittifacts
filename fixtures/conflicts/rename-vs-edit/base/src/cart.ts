export interface Item {
  price: number;
  qty: number;
}

function lineTotal(item: Item): number {
  return item.price * item.qty;
}

export function cartTotal(items: Item[]): number {
  let total = 0;
  for (const item of items) total += lineTotal(item);
  return total;
}
